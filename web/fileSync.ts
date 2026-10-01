import { writeHandle } from './fileAccess';

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
