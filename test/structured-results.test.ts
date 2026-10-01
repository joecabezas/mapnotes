import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGraphFile } from '../shared/fileStore.ts';

// Drives the real MCP server over stdio. The SDK client validates every
// structuredContent against the tool's declared outputSchema.
const server = path.resolve(import.meta.dirname, '../mcp/server.ts');

let dir: string;
let file: string;
let client: Client;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
  file = path.join(dir, 'g.yaml');
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', server, file], stderr: 'ignore' }),
  );
});

afterEach(async () => {
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return client.callTool({ name, arguments: args });
}

describe('MCP structured results', () => {
  it('declares an output schema for every tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => !t.outputSchema).map((t) => t.name)).toEqual([]);
  });

  it('returns generated node and edge ids without parsing prose', async () => {
    const a = await call('add_node', { label: 'A' });
    const b = await call('add_node', { label: 'B' });
    const aId = a.structuredContent.node.id;
    const bId = b.structuredContent.node.id;
    expect(aId).toEqual(expect.any(String));
    expect(a.structuredContent).toEqual({ node: { id: aId, label: 'A', properties: [] }, file });

    const e = await call('add_edge', { source: aId, target: bId });
    const eId = e.structuredContent.edge.id;
    expect(e.structuredContent.edge).toMatchObject({ source: aId, target: bId });

    const saved = await readGraphFile(file);
    expect(saved.nodes.map((n) => n.id)).toEqual([aId, bId]);
    expect(saved.edges.map((x) => x.id)).toEqual([eId]);
  });

  it('keeps concise human-readable text', async () => {
    const a = await call('add_node', { id: 'a' });
    expect(a.content).toEqual([{ type: 'text', text: expect.stringContaining('Added node "a"') }]);
    await call('add_node', { id: 'b' });
    await call('add_edge', { id: 'ab', source: 'a', target: 'b', label: 'x' });

    const got = await call('get_node', { id: 'a' });
    expect(got.content[0].text).toBe('Node "a" "a"\n1 connected edge(s)\n- "ab" a → b "x"');
    expect(got.content[0].text).not.toContain('{');
    expect(got.structuredContent).toEqual({
      node: { id: 'a', label: 'a', properties: [] },
      edges: [{ id: 'ab', source: 'a', target: 'b', label: 'x', properties: [] }],
    });
  });

  it('returns the graph and mutation results as data', async () => {
    await call('add_node', { id: 'a' });
    await call('add_node', { id: 'b' });
    await call('add_edge', { id: 'ab', source: 'a', target: 'b' });

    const edited = await call('edit_node', { id: 'a', newId: 'c', setProperties: [{ key: 'k', value: 'v' }] });
    expect(edited.structuredContent.node).toEqual({ id: 'c', label: 'a', properties: [{ key: 'k', value: 'v' }] });

    const style = await call('set_style', { id: 's', target: 'node', color: '#fff' });
    expect(style.structuredContent.style).toEqual({ id: 's', target: 'node', color: '#fff' });

    const props = await call('edit_graph_properties', { set: [{ key: 'title', value: 'T' }] });
    expect(props.structuredContent).toEqual({ properties: [{ key: 'title', value: 'T' }], file });

    const graph = await call('get_graph');
    expect(graph.structuredContent.file).toBe(file);
    expect(graph.structuredContent.graph).toEqual(await readGraphFile(file));

    const removed = await call('remove_node', { id: 'c' });
    expect(removed.structuredContent).toEqual({ removedNode: 'c', removedEdges: ['ab'], file });

    const loaded = await call('load_graph', { path: file });
    expect(loaded.structuredContent.counts).toEqual({ nodes: 1, edges: 0, styles: 1, properties: 1 });
  });

  it('reports errors without structured content', async () => {
    const got = await call('get_node', { id: 'missing' });
    expect(got.isError).toBe(true);
    expect(got.structuredContent).toBeUndefined();
    expect(got.content[0].text).toMatch(/does not exist/);
  });
});
