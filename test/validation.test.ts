import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGraphFile } from '../shared/fileStore.ts';
import { normalizeGraph } from '../shared/model.ts';
import { parseGraphText } from '../shared/yaml.ts';

// TODO.md: "Report invalid graph entries instead of silently dropping them".

const BAD_YAML = `
styles:
  - { id: s, color: red }
  - { id: s, color: blue }
  - { color: green }
nodes:
  - { id: a }
  - { label: no id }
  - junk
  - { id: b }
edges:
  - { source: a }
  - 42
  - { source: a, target: b }
`;

const BAD_ISSUES = [
  'styles[1] ("s") was dropped: duplicate style id "s" (the first one is kept)',
  'styles[2] was dropped: it has no "id"',
  'nodes[1] was dropped: it has no "id"',
  'nodes[2] was dropped: it is not a mapping',
  'edges[0] was dropped: it needs both a "source" and a "target"',
  'edges[1] was dropped: it is not a mapping',
];

describe('normalizeGraph diagnostics', () => {
  it('reports every dropped node, edge and duplicate style', () => {
    const issues: string[] = [];
    const g = parseGraphText(BAD_YAML, issues);
    expect(issues).toEqual(BAD_ISSUES);
    // The valid entries are still kept.
    expect(g.styles).toEqual([{ id: 's', target: 'node', color: 'red' }]);
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(g.edges.map((e) => [e.source, e.target])).toEqual([['a', 'b']]);
  });

  it('reports sections that are not lists', () => {
    const issues: string[] = [];
    const g = normalizeGraph({ styles: 'x', nodes: { a: 1 }, edges: 3 }, issues);
    expect(g.nodes).toEqual([]);
    expect(issues).toEqual([
      '"styles" must be a list; it was ignored',
      '"nodes" must be a list; it was ignored',
      '"edges" must be a list; it was ignored',
    ]);
  });

  it('reports nothing for a valid graph or missing sections', () => {
    const issues: string[] = [];
    normalizeGraph({ styles: [{ id: 's' }], nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] }, issues);
    normalizeGraph({}, issues);
    normalizeGraph(null, issues);
    expect(issues).toEqual([]);
  });

  it('still works without an issues list', () => {
    expect(parseGraphText(BAD_YAML).nodes).toHaveLength(2);
  });
});

describe('graph files with invalid entries', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
    file = path.join(dir, 'bad.yaml');
    await fs.writeFile(file, BAD_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('readGraphFile reports the dropped entries', async () => {
    const issues: string[] = [];
    await readGraphFile(file, issues);
    expect(issues).toEqual(BAD_ISSUES);
  });

  it('the MCP server reports them and does not overwrite the file until save_graph', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('mcp/server.ts')], stderr: 'ignore' }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content[0].text, isError: !!res.isError };
    };
    try {
      const loaded = await call('load_graph', { path: file });
      for (const issue of BAD_ISSUES) expect(loaded.text).toContain(issue);

      // Before the fix this silently rewrote the file without the invalid entries.
      const added = await call('add_node', { label: 'new' });
      expect(added.isError).toBe(true);
      expect(added.text).toContain('Not saved');
      expect(await fs.readFile(file, 'utf8')).toBe(BAD_YAML);

      expect((await call('get_graph')).text).toContain(`# Warning: ${BAD_ISSUES[0]}`);

      const saved = await call('save_graph');
      expect(saved.isError).toBe(false);
      expect(saved.text).toContain('Dropped 6 invalid entries');
      expect(await fs.readFile(file, 'utf8')).not.toBe(BAD_YAML);

      // The file is clean now, so changes are saved automatically again.
      expect((await call('add_node', { label: 'new' })).isError).toBe(false);
      expect((await readGraphFile(file)).nodes).toHaveLength(3);
    } finally {
      await client.close();
    }
  }, 20000);
});
