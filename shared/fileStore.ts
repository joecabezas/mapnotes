// Node-only helpers for reading/writing graph files on disk.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emptyGraph, type Graph } from './model.ts';
import { formatForPath, parseGraphText, serializeGraph } from './yaml.ts';

/** Entries that had to be dropped are described in `issues` (see `normalizeGraph`). */
export async function readGraphFile(file: string, issues?: string[]): Promise<Graph> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyGraph();
    throw err;
  }
  return parseGraphText(text, issues);
}

/** Writes atomically (temp file + rename) so watchers never see half a file. */
export async function writeGraphText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

export async function writeGraphFile(file: string, graph: Graph): Promise<string> {
  const text = serializeGraph(graph, formatForPath(file));
  await writeGraphText(file, text);
  return text;
}
