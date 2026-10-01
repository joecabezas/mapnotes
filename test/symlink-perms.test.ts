import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeGraphText } from '../shared/fileStore.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapnotes-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const at = (name: string) => path.join(dir, name);
const isRoot = process.getuid?.() === 0;

// TODO.md: "Preserve the linked file's identity and permissions on write."
// Before the fix, the temp-file rename replaced a symlink with a regular file
// and gave the destination the temp file's (umask-derived) mode.
describe('writeGraphText through symlinks', () => {
  it('keeps the link and writes its target', async () => {
    await fs.writeFile(at('real.yaml'), 'old');
    await fs.symlink('real.yaml', at('link.yaml'));
    await writeGraphText(at('link.yaml'), 'new');
    expect((await fs.lstat(at('link.yaml'))).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(at('link.yaml'))).toBe('real.yaml');
    expect(await fs.readFile(at('real.yaml'), 'utf8')).toBe('new');
  });

  it('follows a chain of links to the final target', async () => {
    await fs.writeFile(at('real.yaml'), 'old');
    await fs.symlink('real.yaml', at('a.yaml'));
    await fs.symlink('a.yaml', at('b.yaml'));
    await writeGraphText(at('b.yaml'), 'new');
    expect((await fs.lstat(at('a.yaml'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(at('b.yaml'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(at('real.yaml'), 'utf8')).toBe('new');
  });

  it('creates the target of a dangling link, including missing directories', async () => {
    await fs.symlink(path.join('sub', 'g.yaml'), at('link.yaml'));
    await writeGraphText(at('link.yaml'), 'new');
    expect((await fs.lstat(at('link.yaml'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(at('sub/g.yaml'), 'utf8')).toBe('new');
  });

  it('rejects a symlink loop', async () => {
    await fs.symlink('b.yaml', at('a.yaml'));
    await fs.symlink('a.yaml', at('b.yaml'));
    await expect(writeGraphText(at('a.yaml'), 'x')).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('leaves no temporary file next to the link or the target', async () => {
    await fs.mkdir(at('sub'));
    await fs.writeFile(at('sub/real.yaml'), 'old');
    await fs.symlink(path.join('sub', 'real.yaml'), at('link.yaml'));
    await writeGraphText(at('link.yaml'), 'new');
    expect((await fs.readdir(dir)).sort()).toEqual(['link.yaml', 'sub']);
    expect(await fs.readdir(at('sub'))).toEqual(['real.yaml']);
  });
});

describe('writeGraphText permissions', () => {
  it.each([0o600, 0o640, 0o664])('keeps mode %o of an existing file', async (mode) => {
    await fs.writeFile(at('g.yaml'), 'old');
    await fs.chmod(at('g.yaml'), mode);
    await writeGraphText(at('g.yaml'), 'new');
    expect((await fs.stat(at('g.yaml'))).mode & 0o777).toBe(mode);
    expect(await fs.readFile(at('g.yaml'), 'utf8')).toBe('new');
  });

  it('keeps the mode of a symlink target', async () => {
    await fs.writeFile(at('real.yaml'), 'old');
    await fs.chmod(at('real.yaml'), 0o600);
    await fs.symlink('real.yaml', at('link.yaml'));
    await writeGraphText(at('link.yaml'), 'new');
    expect((await fs.stat(at('real.yaml'))).mode & 0o777).toBe(0o600);
  });

  // Root bypasses permission checks, so the file would count as writable.
  it.skipIf(isRoot)('rejects a read-only file and leaves it untouched', async () => {
    await fs.writeFile(at('g.yaml'), 'keep');
    await fs.chmod(at('g.yaml'), 0o444);
    await expect(writeGraphText(at('g.yaml'), 'new')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readFile(at('g.yaml'), 'utf8')).toBe('keep');
    expect(await fs.readdir(dir)).toEqual(['g.yaml']);
  });
});
