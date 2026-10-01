import { describe, expect, it } from 'vitest';
import { readHandle, writeHandle } from '../web/fileAccess.ts';
import { writeFileText } from '../web/fileSync.ts';

/** In-memory stand-in for a File System Access API file handle. */
function fakeHandle(opts: { failWrites?: number } = {}) {
  let failWrites = opts.failWrites ?? 0;
  const state = { text: '', lastModified: 1 };
  const handle = {
    name: 'graph.yaml',
    async getFile() {
      return { text: async () => state.text, lastModified: state.lastModified };
    },
    async createWritable() {
      if (failWrites > 0) {
        failWrites--;
        throw new DOMException('disk full', 'InvalidStateError');
      }
      let pending = '';
      return {
        async write(chunk: string) {
          pending += chunk;
        },
        async close() {
          state.text = pending;
          state.lastModified++;
        },
      };
    },
  };
  return { handle: handle as unknown as FileSystemFileHandle, state };
}

describe('writeHandle / readHandle', () => {
  it('writes the whole text and returns the new modification time', async () => {
    const { handle, state } = fakeHandle();
    expect(await writeHandle(handle, 'nodes: []\n')).toBe(2);
    expect(state.text).toBe('nodes: []\n');
    expect(await readHandle(handle)).toEqual({ text: 'nodes: []\n', lastModified: 2 });
  });

  it('rejects when the file cannot be opened for writing, leaving it unchanged', async () => {
    const { handle, state } = fakeHandle({ failWrites: 1 });
    state.text = 'old';
    await expect(writeHandle(handle, 'new')).rejects.toThrow('disk full');
    expect(state.text).toBe('old');
    expect(await writeHandle(handle, 'new')).toBe(2);
    expect(state.text).toBe('new');
  });
});

// The browser autosave and poll loops live in effects in web/App.tsx. These
// cases are tracked by TODO.md items being fixed separately; enable them once
// the save/poll logic can be driven from a test.
describe('browser save/poll races (web/App.tsx)', () => {
  // TODO.md: "Keep failed browser saves pending."
  // More cases in save-retry.test.ts.
  it('a failed autosave keeps the graph pending and retrying without edits writes it', async () => {
    const { handle, state } = fakeHandle({ failWrites: 1 });
    state.text = 'old';
    const refs = { fileText: { current: 'old' as string | null }, fileModified: { current: 1 }, writingText: { current: null } };
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow('disk full');
    expect(refs.fileText.current).toBe('old');
    await writeFileText(handle, 'new', refs);
    expect(state.text).toBe('new');
    expect(refs.fileText.current).toBe('new');
  });
  it('a failed manual save leaves the status in error until a retry succeeds', async () => {
    const { handle, state } = fakeHandle({ failWrites: 2 });
    const refs = { fileText: { current: '' as string | null }, fileModified: { current: 1 }, writingText: { current: null } };
    // App shows "Save failed" while writeFileText rejects, and "Saved" once it resolves.
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow('disk full');
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow('disk full');
    expect(refs.fileText.current).toBe('');
    await expect(writeFileText(handle, 'new', refs)).resolves.toBeUndefined();
    expect(state.text).toBe('new');
  });

  // TODO.md: "Detect external changes before replacing a linked file."
  it.todo('an external edit between a browser edit and its autosave is not overwritten');

  // TODO.md: "Retry a rejected external file revision."
  it.todo('a poll that fails to parse is retried for the same modification time');
});
