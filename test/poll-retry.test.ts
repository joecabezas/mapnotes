import { describe, expect, it } from 'vitest';
import type { Graph } from '../shared/model.ts';
import { createFilePoll } from '../web/filePoll.ts';

const VALID = 'nodes:\n  - id: a\n    label: A\nedges: []\n';
const BROKEN = 'nodes: [ {{{ half written';

/** In-memory stand-in for a linked file handle that other tools change on disk. */
function setup(initial: { text: string; lastModified: number }) {
  const disk = { ...initial, missing: false, reads: 0 };
  const handle = {
    name: 'graph.yaml',
    async getFile() {
      if (disk.missing) throw new DOMException('gone', 'NotFoundError');
      const { text, lastModified } = disk;
      return {
        lastModified,
        text: async () => {
          disk.reads++;
          return text;
        },
      };
    },
  };
  const modified = { current: 0 };
  const text = { current: '' };
  const changes: Graph[] = [];
  const errors: Error[] = [];
  let missing = 0;
  const poll = createFilePoll({
    handle: handle as unknown as FileSystemFileHandle,
    modified,
    text,
    onChange: (graph) => changes.push(graph),
    onUnreadable: (err) => errors.push(err),
    onMissing: () => missing++,
  });
  return { disk, modified, text, changes, errors, poll, missing: () => missing };
}

describe('createFilePoll', () => {
  it('retries a revision that failed to parse once it becomes readable, at the same modification time', async () => {
    const s = setup({ text: BROKEN, lastModified: 1000 });
    await s.poll();
    // Before the fix the time was recorded here, so the next poll skipped this revision for good.
    expect(s.modified.current).toBe(0);
    expect(s.changes).toHaveLength(0);

    s.disk.text = VALID; // the writer finishes without the modification time changing
    await s.poll();
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0].nodes.map((n) => n.id)).toEqual(['a']);
    expect(s.modified.current).toBe(1000);
    expect(s.text.current).toBe(VALID);
  });

  it('reports an unreadable revision once while retrying it on every poll', async () => {
    const s = setup({ text: BROKEN, lastModified: 1000 });
    await s.poll();
    await s.poll();
    await s.poll();
    expect(s.disk.reads).toBe(3);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toBeInstanceOf(Error);

    s.disk.lastModified = 2000; // a different bad revision is reported again
    await s.poll();
    expect(s.errors).toHaveLength(2);
  });

  it('reports a bad revision again after a good one was read in between', async () => {
    const s = setup({ text: BROKEN, lastModified: 1000 });
    await s.poll();
    s.disk.text = VALID;
    await s.poll();
    s.disk.text = BROKEN;
    s.disk.lastModified = 1000; // e.g. coarse timestamps
    s.modified.current = 999; // and the app wrote something in between
    await s.poll();
    expect(s.errors).toHaveLength(2);
  });

  it('does not read a revision it has already seen', async () => {
    const s = setup({ text: VALID, lastModified: 1000 });
    await s.poll();
    await s.poll();
    expect(s.disk.reads).toBe(1);
    expect(s.changes).toHaveLength(1);
  });

  it('records a new revision whose text is already loaded without reloading the graph', async () => {
    const s = setup({ text: VALID, lastModified: 1000 });
    s.text.current = VALID;
    await s.poll();
    expect(s.changes).toHaveLength(0);
    expect(s.modified.current).toBe(1000);
  });

  it('reports a moved or deleted file as missing, not unreadable', async () => {
    const s = setup({ text: VALID, lastModified: 1000 });
    s.disk.missing = true;
    await s.poll();
    expect(s.missing()).toBe(1);
    expect(s.errors).toHaveLength(0);
  });
});
