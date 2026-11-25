import { execFileSync } from 'node:child_process';

// An unavailable or unbound input diff grants no screen exemption.
export function inputSources({ sourceRoot, baseSHA, headSHA }) {
  if (typeof sourceRoot !== 'string' || !/^[a-f0-9]{40}$/u.test(baseSHA ?? '') || !/^[a-f0-9]{40}$/u.test(headSHA ?? '')) return undefined;
  try {
    const inputDiff = execFileSync('git', ['-C', sourceRoot, 'diff', '--no-ext-diff', '--no-textconv', baseSHA, headSHA, '--'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return { inputDiff };
  } catch { return undefined; }
}
