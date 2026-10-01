// Read and write graph files on disk straight from the browser, using the File
// System Access API (Chrome, Edge and other Chromium browsers). Browsers without
// it (Firefox, Safari) fall back to plain upload/download in App.tsx.

// Parts of the API that TypeScript's DOM types don't include yet.
type PermissionMode = { mode: 'read' | 'readwrite' };
interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}
declare global {
  interface FileSystemHandle {
    queryPermission(opts: PermissionMode): Promise<PermissionState>;
    requestPermission(opts: PermissionMode): Promise<PermissionState>;
  }
  interface Window {
    showOpenFilePicker(opts?: { types?: PickerType[]; excludeAcceptAllOption?: boolean }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(opts?: { suggestedName?: string; types?: PickerType[] }): Promise<FileSystemFileHandle>;
  }
}

export const fileAccessSupported = typeof window !== 'undefined' && 'showOpenFilePicker' in window;

const PICKER_TYPES: PickerType[] = [
  { description: 'Graph (YAML)', accept: { 'text/yaml': ['.yaml', '.yml'] } },
  { description: 'Graph (JSON)', accept: { 'application/json': ['.json'] } },
];

/** True when the user dismissed a picker; callers should do nothing. */
export const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

/** Resolves to null if the user cancels. */
export async function pickFileToOpen(): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES });
    return handle ?? null;
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/** Resolves to null if the user cancels. */
export async function pickFileToSave(suggestedName: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker({ suggestedName, types: PICKER_TYPES });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export async function readHandle(handle: FileSystemFileHandle): Promise<{ text: string; lastModified: number }> {
  const file = await handle.getFile();
  return { text: await file.text(), lastModified: file.lastModified };
}

/** Writes the whole file; returns its new modification time. */
export async function writeHandle(handle: FileSystemFileHandle, text: string): Promise<number> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return (await handle.getFile()).lastModified;
}

/**
 * Writes the whole file only if it still holds `expected` (what we last read or
 * wrote), so edits other tools made in the meantime are never overwritten.
 * Returns the new modification time, or null when the file changed.
 */
export async function writeHandleIfUnchanged(handle: FileSystemFileHandle, expected: string, text: string): Promise<number | null> {
  if ((await readHandle(handle)).text !== expected) return null;
  return writeHandle(handle, text);
}

/**
 * Whether we may read and write the file. Browsers forget the grant when the
 * page reloads; asking again (`request`) must happen inside a click handler.
 */
export async function hasPermission(handle: FileSystemFileHandle, request = false): Promise<boolean> {
  const opts: PermissionMode = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return request && (await handle.requestPermission(opts)) === 'granted';
}

// ---- Remember the open file across reloads. Handles can't go in localStorage,
// but IndexedDB can store them.

const DB_NAME = 'mapnotes';
const STORE = 'handles';
const KEY = 'current';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const conn = await db();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(conn.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    conn.close();
  }
}

export async function rememberHandle(handle: FileSystemFileHandle | null): Promise<void> {
  try {
    await withStore('readwrite', (s) => (handle ? s.put(handle, KEY) : s.delete(KEY)));
  } catch {
    /* storage unavailable: the file just won't be reopened after a reload */
  }
}

export async function recallHandle(): Promise<FileSystemFileHandle | null> {
  try {
    return ((await withStore('readonly', (s) => s.get(KEY))) as FileSystemFileHandle | undefined) ?? null;
  } catch {
    return null;
  }
}
