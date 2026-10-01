// Node-only helpers for reading/writing graph files on disk.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
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
 *
 * - Symlinks are followed: the link's final target is replaced and the link
 *   itself stays in place (a dangling link creates its target).
 * - An existing target keeps its permission bits. Ownership is not preserved;
 *   the file ends up owned by the writing process.
 * - An existing target we may not write to (e.g. mode 0444) is rejected with
 *   EACCES rather than silently replaced via the rename.
 * - The temp file is created exclusively with a random name next to the
 *   target, and removed if writing or renaming fails.
 */
export async function writeGraphText(file: string, text: string): Promise<void> {
  const target = await resolveLinks(file);
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode & 0o7777;
    await fs.access(target, fsConstants.W_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  // 'wx' fails instead of reusing a name, so we only ever clean up our own file.
  const handle = await fs.open(tmp, 'wx');
  try {
    try {
      await handle.writeFile(text, 'utf8');
      if (mode !== undefined) await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Follows symlinks (including dangling ones) to the path that should be written. */
async function resolveLinks(file: string): Promise<string> {
  let current = path.resolve(file);
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // realpath fails if the file (or a link's target) doesn't exist yet.
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return current;
      throw err;
    }
    if (!stat.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), await fs.readlink(current));
  }
  throw Object.assign(new Error(`ELOOP: too many symbolic links: ${file}`), { code: 'ELOOP' });
}

export async function writeGraphFile(file: string, graph: Graph): Promise<string> {
  const text = serializeGraph(graph, formatForPath(file));
  await writeGraphText(file, text);
  return text;
}
