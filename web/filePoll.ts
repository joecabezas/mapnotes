// One step of watching a linked file for changes other tools (e.g. the MCP server)
// make to it. App.tsx runs it on a timer; kept free of React so it can be tested.

import type { Graph } from '../shared/model';
import { parseGraphText } from '../shared/yaml';

export interface FilePollOptions {
  handle: FileSystemFileHandle;
  /** Modification time of the last revision read, parsed or written. */
  modified: { current: number };
  /** Text of that revision. */
  text: { current: string | null };
  /** Text of our own write still in flight; seeing it is not another tool's edit. */
  writing?: { current: string | null };
  /** `issues` lists entries of the file that were dropped while reading it. */
  onChange: (graph: Graph, issues: string[]) => void;
  /** Called once per revision that can't be read or parsed; it is retried on every poll. */
  onUnreadable: (err: Error) => void;
  onMissing: () => void;
}

/** Returns a function that checks the file once; it must not be called again before it settles. */
export function createFilePoll({ handle, modified, text, writing, onChange, onUnreadable, onMissing }: FilePollOptions) {
  let rejected = 0; // modification time of the last revision reported as unreadable
  return async () => {
    let lastModified = 0;
    try {
      const current = await handle.getFile();
      lastModified = current.lastModified;
      if (lastModified === modified.current) return;
      const next = await current.text();
      if (next === writing?.current) return;
      if (next !== text.current) {
        const issues: string[] = [];
        const graph = parseGraphText(next, issues);
        text.current = next;
        onChange(graph, issues);
      }
      // Only a revision that was read and parsed counts as seen, so a failed one is retried.
      modified.current = lastModified;
      rejected = 0;
    } catch (err) {
      if ((err as DOMException).name === 'NotFoundError') onMissing();
      else if (lastModified !== rejected) {
        rejected = lastModified;
        onUnreadable(err as Error);
      }
    }
  };
}
