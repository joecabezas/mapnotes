// Node-only helpers for reading/writing graph files on disk.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emptyGraph, type Graph } from './model.ts';
import { formatForPath, parseGraphText, serializeGraph } from './yaml.ts';

export async function readGraphFile(file: string): Promise<Graph> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyGraph();
    throw err;
  }
  return parseGraphText(text);
}

/**
 * Writes atomically (temp file + rename) so watchers never see half a file.
 * The temp file is created exclusively with a random name next to the target,
 * and removed if writing or renaming fails.
 */
export async function writeGraphText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  // 'wx' fails instead of reusing a name, so we only ever clean up our own file.
  const handle = await fs.open(tmp, 'wx');
  try {
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeGraphFile(file: string, graph: Graph): Promise<string> {
  const text = serializeGraph(graph, formatForPath(file));
  await writeGraphText(file, text);
  return text;
}
