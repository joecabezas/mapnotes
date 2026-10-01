import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGraphFile, writeGraphFile } from '../shared/fileStore.ts';
import { addNode } from '../shared/model.ts';

// TODO.md: "Serialize MCP read–modify–write operations for one graph file."

const serverPath = path.resolve(import.meta.dirname, '../mcp/server.ts');
const N = 20;

let dir: string;
let file: string;
let client: Client | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
  file = path.join(dir, 'g.yaml');
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

/** Starts the real MCP server over stdio with `file` as the current graph file. */
async function connect(): Promise<Client> {
  client = new Client({ name: 'mapnotes-test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', serverPath, file], stderr: 'ignore' }),
  );
  return client;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);

describe('unserialized read-modify-write (the bug)', () => {
  it('loses edits when concurrent writers read the same revision', async () => {
    // What every tool handler did before the fix: read, change, write the whole file.
    await Promise.allSettled(
      ids(N).map(async (id) => {
        const { graph } = addNode(await readGraphFile(file), { id });
        await writeGraphFile(file, graph);
      }),
    );
    expect((await readGraphFile(file)).nodes.length).toBeLessThan(N);
  });
});

describe('MCP server', () => {
  it('keeps every node from simultaneous add_node calls', async () => {
    const c = await connect();
    const results = await Promise.all(ids(N).map((id) => c.callTool({ name: 'add_node', arguments: { id } })));
    expect(results.filter((r) => r.isError)).toEqual([]);
    expect((await readGraphFile(file)).nodes.map((n) => n.id).sort()).toEqual(ids(N).sort());
  }, 30_000);

  it('keeps simultaneous edits from different tools', async () => {
    const c = await connect();
    await c.callTool({ name: 'add_node', arguments: { id: 'a' } });
    await Promise.all([
      c.callTool({ name: 'add_node', arguments: { id: 'b' } }),
      c.callTool({ name: 'add_edge', arguments: { id: 'e', source: 'a', target: 'a' } }),
      c.callTool({ name: 'edit_node', arguments: { id: 'a', label: 'A' } }),
      c.callTool({ name: 'edit_graph_properties', arguments: { set: [{ key: 'title', value: 'T' }] } }),
      c.callTool({ name: 'set_style', arguments: { id: 's', target: 'node', color: '#fff' } }),
    ]);
    const graph = await readGraphFile(file);
    expect(graph.nodes.map((n) => [n.id, n.label])).toEqual([
      ['a', 'A'],
      ['b', 'b'],
    ]);
    expect(graph.edges.map((e) => e.id)).toEqual(['e']);
    expect(graph.properties).toEqual([{ key: 'title', value: 'T' }]);
    expect(graph.styles.map((s) => s.id)).toEqual(['s']);
  }, 30_000);

  it('a failing call does not block the calls queued after it', async () => {
    const c = await connect();
    const [bad, good] = await Promise.all([
      c.callTool({ name: 'remove_node', arguments: { id: 'missing' } }),
      c.callTool({ name: 'add_node', arguments: { id: 'a' } }),
    ]);
    expect(bad.isError).toBe(true);
    expect(good.isError).toBeFalsy();
    expect((await readGraphFile(file)).nodes.map((n) => n.id)).toEqual(['a']);
  }, 30_000);
});
