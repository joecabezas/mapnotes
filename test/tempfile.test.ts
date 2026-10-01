import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGraphFile, writeGraphFile, writeGraphText } from '../shared/fileStore.ts';
import { normalizeGraph } from '../shared/model.ts';

// TODO.md: "Make temporary file names collision resistant and clean up after failed writes."

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
  file = path.join(dir, 'g.yaml');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const graph = normalizeGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] });
const boom = () => Object.assign(new Error('boom'), { code: 'EIO' });

describe('writeGraphText temporary files', () => {
  it('concurrent writes within the same millisecond all land and leave no temporary file', async () => {
    // The old PID + Date.now() name collided here: two writers shared one temp
    // path and the second rename failed with ENOENT.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => writeGraphText(file, `properties: { i: ${i} }\n`)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const { properties } = await readGraphFile(file);
    expect(properties).toHaveLength(1);
    expect(Number(properties[0].value)).toBeGreaterThanOrEqual(0);
    expect(await fs.readdir(dir)).toEqual(['g.yaml']);
  });

  it('creates the temporary file exclusively in the destination directory', async () => {
    const open = vi.spyOn(fs, 'open');
    await writeGraphFile(file, graph);
    expect(open).toHaveBeenCalledTimes(1);
    const [tmp, flags] = open.mock.calls[0];
    expect(path.dirname(String(tmp))).toBe(dir);
    expect(String(tmp)).toMatch(/\.tmp$/);
    expect(flags).toBe('wx');
  });

  it('a failed rename removes the temporary file and keeps the previous graph', async () => {
    const before = await writeGraphFile(file, graph);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(boom());
    await expect(writeGraphText(file, 'nodes: [')).rejects.toThrow('boom');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await readGraphFile(file)).toEqual(graph);
    expect(await fs.readdir(dir)).toEqual(['g.yaml']);
  });

  it('a failed write removes the temporary file and keeps the previous graph', async () => {
    const before = await writeGraphFile(file, graph);
    const realOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(boom());
      return handle;
    });
    await expect(writeGraphText(file, 'nodes: []\n')).rejects.toThrow('boom');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(dir)).toEqual(['g.yaml']);
  });

  it('never reuses or deletes an existing file at the chosen temporary path', async () => {
    const before = await writeGraphFile(file, graph);
    let foreign = '';
    const realOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      foreign = String(args[0]);
      await fs.writeFile(foreign, 'someone else');
      return realOpen(...args);
    });
    await expect(writeGraphText(file, 'nodes: []\n')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(foreign, 'utf8')).toBe('someone else');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });
});
