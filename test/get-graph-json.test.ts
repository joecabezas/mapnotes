import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
  client = new Client({ name: 'mapnotes-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'mcp/server.ts'], cwd: root, stderr: 'ignore' }),
  );
});

afterEach(async () => {
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  expect(result.isError).toBeFalsy();
  return result.content.map((c) => c.text).join('');
}

describe('get_graph', () => {
  it('returns parseable JSON for an unsaved graph', async () => {
    await call('add_node', { id: 'a' });
    const text = await call('get_graph', { format: 'json' });
    // Before the fix the text started with "# (unsaved graph)", which JSON.parse rejects.
    expect(text.startsWith('#')).toBe(false);
    expect(JSON.parse(text).nodes.map((n: { id: string }) => n.id)).toEqual(['a']);
  });

  it('returns parseable JSON for a saved graph', async () => {
    const file = path.join(dir, 'g.yaml');
    await call('add_node', { id: 'a' });
    await call('save_graph', { path: file });
    const text = await call('get_graph', { format: 'json' });
    expect(text).not.toContain(file);
    expect(JSON.parse(text).nodes.map((n: { id: string }) => n.id)).toEqual(['a']);
  });

  it('keeps the file comment on YAML output', async () => {
    expect(await call('get_graph')).toMatch(/^# \(unsaved graph\)\n/);
    const file = path.join(dir, 'g.yaml');
    await call('save_graph', { path: file });
    expect(await call('get_graph', { format: 'yaml' })).toMatch(new RegExp(`^# ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
  });

  it('includes saved views in JSON output', async () => {
    const file = path.join(dir, 'views.yaml');
    await call('save_graph', {
      path: file,
    });
    await call('load_graph', { path: file });
    const yaml = `views:
  - id: v1
    name: People
    filters:
      types: [person]
nodes:
  - id: a
    label: A
`;
    await fs.writeFile(file, yaml);
    await call('load_graph', { path: file });
    const parsed = JSON.parse(await call('get_graph', { format: 'json' }));
    expect(parsed.views[0].name).toBe('People');
  });
});
