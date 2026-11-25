import { execFileSync } from 'node:child_process';

function hunkTexts(diff) {
  const excerpts = []; let before = [], after = [], raw = [], inHunk = false;
  const flush = () => { if (inHunk) excerpts.push(before.join('\n'), after.join('\n'), raw.join('\n')); before = []; after = []; raw = []; inHunk = false; };
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) { flush(); inHunk = true; continue; }
    if (line.startsWith('diff --git ')) { flush(); continue; }
    if (!inHunk || !line) continue;
    raw.push(line);
    if (line[0] === ' ') { before.push(line.slice(1)); after.push(line.slice(1)); }
    else if (line[0] === '-') before.push(line.slice(1));
    else if (line[0] === '+') after.push(line.slice(1));
  }
  flush(); return excerpts;
}

// Return only data from the pinned input trees and their diff. A missing or
// unavailable binding gives no exemption; it never weakens the screen.
export function inputSources({ sourceRoot, baseSHA, headSHA }) {
  if (typeof sourceRoot !== 'string' || !/^[a-f0-9]{40}$/u.test(baseSHA ?? '') || !/^[a-f0-9]{40}$/u.test(headSHA ?? '')) return undefined;
  const run = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const diff = run('diff', '--no-ext-diff', '--no-textconv', baseSHA, headSHA, '--');
    const phraseSources = [diff], changedCodeSources = hunkTexts(diff);
    for (const revision of [baseSHA, headSHA]) {
      try { phraseSources.push(run('grep', '-I', '-i', '-h', '-e', 'adaptive', revision, '--')); }
      catch (error) { if (error?.status !== 1) throw error; }
    }
    const files = run('diff', '--name-only', '-z', '--diff-filter=ACDMRT', baseSHA, headSHA, '--').split('\0').filter(Boolean);
    let bytes = phraseSources.reduce((total, source) => total + Buffer.byteLength(source), 0);
    for (const file of files) {
      for (const revision of [baseSHA, headSHA]) {
        let source; try { source = run('show', `${revision}:${file}`); } catch (error) { if (error?.status === 128) continue; throw error; }
        bytes += Buffer.byteLength(source);
        if (bytes > 16 * 1024 * 1024) return undefined;
        phraseSources.push(source);
      }
    }
    return { phraseSources, changedCodeSources };
  } catch { return undefined; }
}
