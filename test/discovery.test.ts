import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { addNode, emptyGraph, type Graph, GraphError, normalizeGraph, removeNode } from '../shared/model.ts';
import { findNodes } from '../shared/search.ts';

function sample(): Graph {
  return normalizeGraph({
    styles: [{ id: 'svc', target: 'node' }],
    nodes: [
      { id: 'api', label: 'Payments API', style: 'svc', properties: [{ key: 'owner', value: 'Team Blue' }] },
      { id: 'db', label: 'Postgres', properties: [{ key: 'tier', value: 'storage' }] },
      { id: 'web', label: 'Frontend', properties: [{ key: 'owner', value: 'team red' }] },
    ],
    edges: [
      { source: 'api', target: 'db' },
      { source: 'web', target: 'api' },
    ],
  });
}

const ids = (g: Graph, input: Parameters<typeof findNodes>[1]) => findNodes(g, input).nodes.map((n) => n.id);

function bigGraph(count: number): { graph: Graph; ids: string[] } {
  let graph = emptyGraph();
  const all: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${String(i).padStart(4, '0')}`;
    all.push(id);
    graph = addNode(graph, { id, label: `Node ${i}` }).graph;
  }
  // File order must not affect paging.
  return { graph: { ...graph, nodes: [...graph.nodes].reverse() }, ids: all };
}

describe('findNodes matching', () => {
  it('matches labels case-insensitively and returns a brief summary', () => {
    expect(findNodes(sample(), { query: 'payments' })).toEqual({
      total: 1,
      nodes: [{ id: 'api', label: 'Payments API', style: 'svc', properties: 1, edges: 2, matched: ['label'] }],
    });
  });

  it('matches ids', () => {
    expect(findNodes(sample(), { query: 'DB' }).nodes.map((n) => [n.id, n.matched])).toEqual([['db', ['id']]]);
  });

  it('matches property keys and values', () => {
    expect(findNodes(sample(), { query: 'storage' }).nodes.map((n) => [n.id, n.matched])).toEqual([
      ['db', ['property:tier']],
    ]);
    expect(ids(sample(), { query: 'owner' })).toEqual(['api', 'web']);
  });

  it('filters by property key and value', () => {
    expect(ids(sample(), { propertyKey: 'OWNER' })).toEqual(['api', 'web']);
    expect(ids(sample(), { propertyKey: 'owner', propertyValue: 'RED' })).toEqual(['web']);
    expect(ids(sample(), { propertyValue: 'stor' })).toEqual(['db']);
  });

  it('filters by style, "" meaning no style', () => {
    expect(ids(sample(), { style: 'svc' })).toEqual(['api']);
    expect(ids(sample(), { style: '' })).toEqual(['db', 'web']);
  });

  it('lists every node without filters and nothing for a miss', () => {
    expect(ids(sample(), {})).toEqual(['api', 'db', 'web']);
    expect(findNodes(sample(), { query: 'nothing' })).toEqual({ total: 0, nodes: [] });
  });

  it('rejects out-of-range limits', () => {
    expect(() => findNodes(sample(), { limit: 0 })).toThrow(GraphError);
    expect(() => findNodes(sample(), { limit: 201 })).toThrow(GraphError);
    expect(() => findNodes(sample(), { limit: 1.5 })).toThrow(GraphError);
  });
});

describe('findNodes pagination', () => {
  it('pages through a large graph in id order with a default limit', () => {
    const { graph, ids: all } = bigGraph(1234);
    expect(findNodes(graph).nodes).toHaveLength(50);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = findNodes(graph, { limit: 100, cursor });
      expect(page.total).toBe(1234);
      expect(page.nodes.length).toBeLessThanOrEqual(100);
      seen.push(...page.nodes.map((n) => n.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(13);
    expect(seen).toEqual(all);
  });

  it('stays stable when nodes are added or removed between pages', () => {
    let { graph, ids: all } = bigGraph(50);
    const first = findNodes(graph, { limit: 10 });
    graph = removeNode(graph, 'n0010').graph;
    graph = addNode(graph, { id: 'n0000a', label: 'late' }).graph;
    expect(ids(graph, { limit: 10, cursor: first.nextCursor })).toEqual(all.slice(11, 21));
  });

  it('omits nextCursor on the last page and returns nothing past the end', () => {
    expect(findNodes(sample(), { limit: 3 }).nextCursor).toBeUndefined();
    expect(findNodes(sample(), { limit: 2 }).nextCursor).toBe('db');
    expect(ids(sample(), { cursor: 'zzz' })).toEqual([]);
  });
});

describe('find_nodes MCP tool', () => {
  // Before this tool existed, agents could only fetch the whole graph or a known id.
  it('is exposed by the server and returns paged summaries', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', path.join(root, 'mcp/server.ts')],
        cwd: root,
        stderr: 'ignore',
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('find_nodes');

      await client.callTool({ name: 'add_node', arguments: { id: 'a', label: 'Alpha' } });
      await client.callTool({ name: 'add_node', arguments: { id: 'b', label: 'Beta' } });
      const res = (await client.callTool({ name: 'find_nodes', arguments: { limit: 1 } })) as {
        content: { text: string }[];
      };
      expect(JSON.parse(res.content[0].text)).toEqual({
        total: 2,
        nodes: [{ id: 'a', label: 'Alpha', properties: 0, edges: 0 }],
        nextCursor: 'a',
      });

      const tooBig = await client.callTool({ name: 'find_nodes', arguments: { limit: 500 } });
      expect(tooBig.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);
});
