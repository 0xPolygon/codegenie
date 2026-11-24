import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
    const moduleURL = pathToFileURL(path.resolve('evals/runner/safe-read.mjs')).href;
    const script = `import { readCheckedFile } from ${JSON.stringify(moduleURL)};
try { readCheckedFile(process.argv[1]); process.exitCode = 1; }
catch (error) { if (error.message !== 'file changed while opening') throw error; }`;
    // A regression in O_NONBLOCK must not hang Vitest's own event loop.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    // Prove the outer deadline also works when the nonblocking flag regresses.
    const source = readFileSync(path.resolve('evals/runner/safe-read.mjs'), 'utf8');
    const blocking = source.replace(' | (constants.O_NONBLOCK ?? 0)', '');
    expect(blocking).not.toBe(source);
    const blockingFile = path.join(dir, 'blocking.mjs'); writeFileSync(blockingFile, blocking);
    const blockedScript = script.replace(JSON.stringify(moduleURL), JSON.stringify(pathToFileURL(blockingFile).href));
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', blockedScript, file], { encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL' });
    expect(blocked.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(blocked.signal).toBe('SIGKILL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
