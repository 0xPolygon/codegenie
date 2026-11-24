import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { readCheckedFile } from '../evals/runner/safe-read.mjs';

it('reads a regular file and rejects a symlink', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-safe-read-'));
  try {
    const file = path.join(dir, 'file'), moved = path.join(dir, 'moved');
    writeFileSync(file, 'original');
    expect(readCheckedFile(file).toString()).toBe('original');
    renameSync(file, moved); symlinkSync(moved, file);
    expect(() => readCheckedFile(file)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-safe-fifo-'));
  try {
    const file = path.join(dir, 'fifo');
    execFileSync('mkfifo', [file]);
    expect(() => readCheckedFile(file)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
