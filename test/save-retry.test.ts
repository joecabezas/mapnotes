import { describe, expect, it } from 'vitest';
import { writeFileText, type FileSyncRefs } from '../web/fileSync.ts';

/** In-memory stand-in for a File System Access API file handle. */
function fakeHandle(opts: { failWrites?: number; text?: string } = {}) {
  let failWrites = opts.failWrites ?? 0;
  const state = { text: opts.text ?? '', lastModified: 1 };
  let release: (() => void) | null = null;
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
          if (hold) await new Promise<void>((r) => (release = r));
          state.text = pending;
          state.lastModified++;
        },
      };
    },
  };
  let hold = false;
  return {
    handle: handle as unknown as FileSystemFileHandle,
    state,
    /** Makes the next write wait in close() until the returned function is called. */
    holdNextWrite() {
      hold = true;
      return () => {
        hold = false;
        release?.();
      };
    },
  };
}

/** The refs App keeps for a file it has just read `text` from. */
function refsFor(text: string): FileSyncRefs {
  return { fileText: { current: text }, fileModified: { current: 1 }, writingText: { current: null } };
}

/** App's autosave writes only when the graph's text differs from what's on disk. */
const autosavePending = (refs: FileSyncRefs, text: string) => text !== refs.fileText.current;

// TODO.md: "Keep failed browser saves pending."
describe('writeFileText (web/App.tsx saves)', () => {
  it('records the text and modification time after a successful write', async () => {
    const { handle, state } = fakeHandle({ text: 'old' });
    const refs = refsFor('old');
    await writeFileText(handle, 'new', refs);
    expect(state.text).toBe('new');
    expect(refs.fileText.current).toBe('new');
    expect(refs.fileModified.current).toBe(2);
    expect(refs.writingText.current).toBeNull();
    expect(autosavePending(refs, 'new')).toBe(false);
  });

  it('keeps a failed write pending instead of treating it as the disk version', async () => {
    const { handle, state } = fakeHandle({ text: 'old', failWrites: 1 });
    const refs = refsFor('old');
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow('disk full');
    // Before the fix fileText became 'new' here, so the unchanged graph never saved again.
    expect(refs.fileText.current).toBe('old');
    expect(refs.fileModified.current).toBe(1);
    expect(refs.writingText.current).toBeNull();
    expect(state.text).toBe('old');
    expect(autosavePending(refs, 'new')).toBe(true);
  });

  it('writes the same text on retry without the graph being edited', async () => {
    const { handle, state } = fakeHandle({ text: 'old', failWrites: 1 });
    const refs = refsFor('old');
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow();
    await writeFileText(handle, 'new', refs);
    expect(state.text).toBe('new');
    expect(refs.fileText.current).toBe('new');
    expect(autosavePending(refs, 'new')).toBe(false);
  });

  it('keeps failing until a retry succeeds', async () => {
    const { handle, state } = fakeHandle({ text: 'old', failWrites: 2 });
    const refs = refsFor('old');
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow();
    await expect(writeFileText(handle, 'new', refs)).rejects.toThrow();
    expect(autosavePending(refs, 'new')).toBe(true);
    await writeFileText(handle, 'new', refs);
    expect(state.text).toBe('new');
    expect(autosavePending(refs, 'new')).toBe(false);
  });

  it('exposes the in-flight text so the file watcher can ignore our own write', async () => {
    const { handle, holdNextWrite } = fakeHandle({ text: 'old' });
    const refs = refsFor('old');
    const release = holdNextWrite();
    const writing = writeFileText(handle, 'new', refs);
    await new Promise((r) => setTimeout(r, 0));
    expect(refs.writingText.current).toBe('new');
    expect(refs.fileText.current).toBe('old');
    release();
    await writing;
    expect(refs.writingText.current).toBeNull();
    expect(refs.fileText.current).toBe('new');
  });
});
