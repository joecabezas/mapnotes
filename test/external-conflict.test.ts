import { describe, expect, it } from 'vitest';
import { readHandle, writeHandle, writeHandleIfUnchanged } from '../web/fileAccess.ts';

/** In-memory stand-in for a File System Access API file handle. */
function fakeHandle(text: string) {
  const state = { text, lastModified: 1 };
  const handle = {
    name: 'graph.yaml',
    async getFile() {
      return { text: async () => state.text, lastModified: state.lastModified };
    },
    async createWritable() {
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
  /** Another tool (an editor, the MCP server) changing the file. */
  const editExternally = (next: string) => {
    state.text = next;
    state.lastModified++;
  };
  return { handle: handle as unknown as FileSystemFileHandle, state, editExternally };
}

const LOADED = 'nodes:\n  - id: a\n    label: Original\n';
const EXTERNAL = 'nodes:\n  - id: a\n    label: From the editor\n';
const BROWSER = 'nodes:\n  - id: a\n    label: Original\n  - id: b\n    label: New node\n';

describe('writeHandleIfUnchanged', () => {
  it('writes when the file still holds the revision the browser loaded', async () => {
    const { handle, state } = fakeHandle(LOADED);
    const { text } = await readHandle(handle);
    expect(await writeHandleIfUnchanged(handle, text, BROWSER)).toBe(2);
    expect(state.text).toBe(BROWSER);
  });

  it('does not overwrite an external edit made between a browser edit and its autosave', async () => {
    const { handle, state, editExternally } = fakeHandle(LOADED);
    const { text } = await readHandle(handle);
    // The browser edits the graph; before the delayed autosave runs, an editor saves the file.
    editExternally(EXTERNAL);
    expect(await writeHandleIfUnchanged(handle, text, BROWSER)).toBeNull();
    expect(state.text).toBe(EXTERNAL);
    expect(state.lastModified).toBe(2);
  });

  it('writes again once the browser has caught up with the external revision', async () => {
    const { handle, state, editExternally } = fakeHandle(LOADED);
    editExternally(EXTERNAL);
    // e.g. after "Keep mine" or "Use file's version", the browser knows the file holds EXTERNAL.
    expect(await writeHandleIfUnchanged(handle, EXTERNAL, BROWSER)).toBe(3);
    expect(state.text).toBe(BROWSER);
  });

  it('treats a touched file with unchanged contents as no conflict', async () => {
    const { handle, state, editExternally } = fakeHandle(LOADED);
    editExternally(LOADED);
    expect(await writeHandleIfUnchanged(handle, LOADED, BROWSER)).toBe(3);
    expect(state.text).toBe(BROWSER);
  });

  // The behavior before the fix: autosave wrote unconditionally and lost the editor's change.
  it('contrasts with writeHandle, which overwrites the external edit', async () => {
    const { handle, state, editExternally } = fakeHandle(LOADED);
    editExternally(EXTERNAL);
    await writeHandle(handle, BROWSER);
    expect(state.text).toBe(BROWSER);
  });
});
