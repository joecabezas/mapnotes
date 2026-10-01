import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGraphFile } from '../shared/fileStore.ts';

// TODO.md: "Treat disappearance of an already linked file as an error."
// Drives the real MCP server over stdio, since the linked-file state lives there.

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
});

afterEach(async () => {
  await client?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function startServer(file?: string) {
  client = new Client({ name: 'test', version: '0' });
  const args = ['--import', 'tsx', path.resolve('mcp/server.ts'), ...(file ? [file] : [])];
  await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: 'ignore' }));
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: res.isError ?? false };
}

const nodeIds = async (file: string) => (await readGraphFile(file)).nodes.map((n) => n.id);

describe('MCP server with a linked file that disappears', () => {
  it('starts an empty graph for a missing file on startup and creates it on the first edit', async () => {
    const file = path.join(dir, 'g.yaml');
    await startServer(file);
    expect((await call('add_node', { id: 'a' })).isError).toBe(false);
    expect(await nodeIds(file)).toEqual(['a']);
  });

  it('starts an empty graph for a missing file on load_graph', async () => {
    const file = path.join(dir, 'new.yaml');
    await startServer();
    const res = await call('load_graph', { path: file });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('0 node(s)');
    expect(existsSync(file)).toBe(false);
  });

  it('fails add_node after the file is deleted instead of recreating it with only the new node', async () => {
    const file = path.join(dir, 'g.yaml');
    await startServer(file);
    await call('add_node', { id: 'a' });
    await call('add_node', { id: 'b' });
    await fs.rm(file);

    const res = await call('add_node', { id: 'c' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/moved or deleted/);
    expect(existsSync(file)).toBe(false);
    expect((await call('get_graph')).isError).toBe(true);
  });

  it('fails after a file that existed at startup is moved away', async () => {
    const file = path.join(dir, 'g.yaml');
    await fs.writeFile(file, 'nodes: [{ id: a }]\n');
    await startServer(file);
    await call('get_graph');
    await fs.rename(file, path.join(dir, 'moved.yaml'));

    expect((await call('add_node', { id: 'b' })).isError).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('save_graph recovers the last known graph, to a new path or back to the original', async () => {
    const file = path.join(dir, 'g.yaml');
    const copy = path.join(dir, 'recovered.yaml');
    await startServer(file);
    await call('add_node', { id: 'a' });
    await call('add_node', { id: 'b' });
    await fs.rm(file);
    await call('add_node', { id: 'c' });

    expect((await call('save_graph', { path: copy })).isError).toBe(false);
    expect(await nodeIds(copy)).toEqual(['a', 'b']);
    // The recovered copy is now the linked file and accepts edits.
    expect((await call('add_node', { id: 'c' })).isError).toBe(false);
    expect(await nodeIds(copy)).toEqual(['a', 'b', 'c']);

    await fs.rm(copy);
    expect((await call('save_graph')).isError).toBe(false);
    expect(await nodeIds(copy)).toEqual(['a', 'b', 'c']);
  });
});
