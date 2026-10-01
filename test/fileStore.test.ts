import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGraphFile, readGraphFileIfExists, writeGraphFile, writeGraphText } from '../shared/fileStore.ts';
import { addNode, emptyGraph, normalizeGraph } from '../shared/model.ts';
import { parseGraphText } from '../shared/yaml.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const graph = normalizeGraph({ nodes: [{ id: 'a', position: { x: 1, y: 2 } }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] });

describe('readGraphFile', () => {
  it('returns an empty graph for a missing file', async () => {
    expect(await readGraphFile(path.join(dir, 'missing.yaml'))).toEqual(emptyGraph());
  });

  it('propagates other read errors', async () => {
    await expect(readGraphFile(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('propagates parse errors', async () => {
    const file = path.join(dir, 'bad.yaml');
    await fs.writeFile(file, 'nodes: [');
    await expect(readGraphFile(file)).rejects.toThrow(/Invalid YAML/);
  });
});

describe('writeGraphFile', () => {
  it.each(['g.yaml', 'g.json'])('round trips through %s', async (name) => {
    const file = path.join(dir, name);
    const text = await writeGraphFile(file, graph);
    expect(await fs.readFile(file, 'utf8')).toBe(text);
    expect(await readGraphFile(file)).toEqual(graph);
    if (name.endsWith('.json')) expect(() => JSON.parse(text)).not.toThrow();
  });

  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'a', 'b', 'g.yaml');
    await writeGraphFile(file, graph);
    expect(await readGraphFile(file)).toEqual(graph);
  });

  it('replaces an existing file and leaves no temporary files', async () => {
    const file = path.join(dir, 'g.yaml');
    await writeGraphFile(file, graph);
    const next = addNode(graph, { id: 'c' }).graph;
    await writeGraphFile(file, next);
    expect(await readGraphFile(file)).toEqual(next);
    expect(await fs.readdir(dir)).toEqual(['g.yaml']);
  });
});

describe('writeGraphText atomicity', () => {
  it('readers only ever see a complete old or new file', async () => {
    const file = path.join(dir, 'g.yaml');
    const small = normalizeGraph({ nodes: [{ id: 'only' }] });
    const big = normalizeGraph({ nodes: Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, label: 'x'.repeat(50) })) });
    await writeGraphFile(file, small);

    let writing = true;
    const reader = (async () => {
      let reads = 0;
      while (writing) {
        const text = await fs.readFile(file, 'utf8');
        const g = parseGraphText(text);
        expect([1, 2000]).toContain(g.nodes.length);
        reads++;
      }
      return reads;
    })();
    for (let i = 0; i < 10; i++) await writeGraphFile(file, i % 2 ? small : big);
    writing = false;
    expect(await reader).toBeGreaterThan(0);
  });

  it('sequential writes in one process each land', async () => {
    const file = path.join(dir, 'g.yaml');
    for (let i = 0; i < 5; i++) {
      await writeGraphText(file, `properties: { i: ${i} }\n`);
      expect((await readGraphFile(file)).properties).toEqual([{ key: 'i', value: String(i) }]);
    }
  });

  // TODO.md: "Make temporary file names collision resistant and clean up after failed writes."
  it.todo('concurrent writes from one process leave a valid graph and no stray temporary file');
  it.todo('a failed rename removes the temporary file and keeps the previous graph');

  // TODO.md: "Preserve the linked file's identity and permissions on write."
  it.todo('writing through a symlink behaves as documented');
  it.todo('writing to a restricted-mode file behaves as documented');

  // TODO.md: "Treat disappearance of an already linked file as an error."
  // The MCP server turns this into an error; see test/linked-missing.test.ts.
  it('reading a previously linked file that was deleted reports it missing instead of returning an empty graph', async () => {
    const file = path.join(dir, 'g.yaml');
    await writeGraphFile(file, graph);
    expect(await readGraphFileIfExists(file)).toEqual(graph);
    await fs.rm(file);
    expect(await readGraphFileIfExists(file)).toBeUndefined();
  });
});
