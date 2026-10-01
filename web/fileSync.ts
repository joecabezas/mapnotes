import { writeHandle, writeHandleIfUnchanged } from './fileAccess';

type Ref<T> = { current: T };

/** What we know of the linked file: refs shared with the autosave and poll loops in App. */
export interface FileSyncRefs {
  /** File contents as last read or written by us, to tell our own writes from other tools' edits. */
  fileText: Ref<string | null>;
  fileModified: Ref<number>;
  /** Text of a write still in flight, so the file watcher doesn't mistake it for another tool's edit. */
  writingText: Ref<string | null>;
}

/** Writes `text` to the file; only a successful write counts as what's on disk. */
export async function writeFileText(handle: FileSystemFileHandle, text: string, refs: FileSyncRefs): Promise<void> {
  refs.writingText.current = text;
  try {
    refs.fileModified.current = await writeHandle(handle, text);
    refs.fileText.current = text;
  } finally {
    refs.writingText.current = null;
  }
}

/**
 * Like writeFileText, but leaves the file alone and returns false when another tool
 * changed it since we last read or wrote it.
 */
export async function writeFileTextIfUnchanged(handle: FileSystemFileHandle, text: string, refs: FileSyncRefs): Promise<boolean> {
  const expected = refs.fileText.current;
  if (expected === null) {
    await writeFileText(handle, text, refs);
    return true;
  }
  refs.writingText.current = text;
  try {
    const modified = await writeHandleIfUnchanged(handle, expected, text);
    if (modified === null) return false;
    refs.fileModified.current = modified;
    refs.fileText.current = text;
    return true;
  } finally {
    refs.writingText.current = null;
  }
}
