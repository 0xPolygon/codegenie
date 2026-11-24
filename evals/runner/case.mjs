import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const urls = { goinfer: 'https://github.com/townsendmerino/goinfer.git', pi: 'https://github.com/earendil-works/pi.git', codegenie: 'https://github.com/0xPolygon/codegenie.git' };
const sha = /^[0-9a-f]{40}$/u;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

export function outsideCheckout(dir) {
  const target = path.resolve(dir);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) throw new Error('unable to resolve output path');
    ancestor = next;
  }
  const resolved = path.resolve(realpathSync(ancestor), path.relative(ancestor, target));
  const root = realpathSync(checkout);
  if (resolved === root || resolved.startsWith(root + path.sep)) throw new Error('campaign output must be outside the checkout');
  return resolved;
}

function validateTarget(target, base, head) {
  if (realpathSync(git(target, 'rev-parse', '--show-toplevel')) !== realpathSync(target)) throw new Error('target must be a Git worktree root');
  if (git(target, 'rev-parse', 'HEAD') !== head || git(target, 'rev-parse', 'HEAD^') !== base || git(target, 'status', '--porcelain') !== '') throw new Error('target checkout does not match clean pinned head and parent');
  try { git(target, 'symbolic-ref', '-q', 'HEAD'); throw new Error('target checkout must be detached'); }
  catch (error) { if (error?.message === 'target checkout must be detached') throw error; if (error?.status !== 1) throw error; }
}

function pathExists(target) {
  try { lstatSync(target); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export function prepareTarget(target, url, base, head, pullRequest) {
  if (!sha.test(base ?? '') || !sha.test(head ?? '')) throw new Error('public case must pin full base and head commit IDs');
  target = outsideCheckout(target);
  if (pathExists(target)) { validateTarget(target, base, head); return target; }
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}-staging-`));
  try {
    git(temporary, 'init', '--quiet');
    try { git(temporary, 'fetch', '--quiet', '--no-tags', '--depth=2', url, head); }
    catch (error) {
      if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) throw error;
      git(temporary, 'fetch', '--quiet', '--no-tags', '--depth=2', url, `refs/pull/${pullRequest}/head`);
      try { git(temporary, 'cat-file', '-e', `${head}^{commit}`); }
      catch { git(temporary, 'fetch', '--quiet', '--no-tags', '--deepen=200', url, `refs/pull/${pullRequest}/head`); }
    }
    git(temporary, 'cat-file', '-e', `${head}^{commit}`);
    git(temporary, 'cat-file', '-e', `${head}^`);
    git(temporary, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', head);
    validateTarget(temporary, base, head);
    // Never intentionally replace a target that appeared while fetching.
    if (pathExists(target)) throw new Error('target appeared while preparing checkout');
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function runCase(configFile, { fetchForCall } = {}) {
  const file = path.resolve(configFile);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || typeof config.caseDir !== 'string' || typeof config.caseName !== 'string') throw new Error('campaign needs caseDir and caseName');
  const suiteDir = path.resolve(path.dirname(file), config.caseDir);
  const output = outsideCheckout(config.outputDir ? path.resolve(path.dirname(file), config.outputDir) : path.join(homedir(), '.cache/codegenie/eval-campaigns', config.caseName));
  const { loadEvalSuite, runEvalCase } = await import('../../dist/evals/eval-runner.js');
  const { loadConfig } = await import('../../dist/config/config-loader.js');
  const suite = await loadEvalSuite(suiteDir);
  const found = suite.cases.filter((candidate) => candidate.evalCase.name === config.caseName);
  if (found.length !== 1) throw new Error('campaign caseName must match one case');
  const original = found[0];
  const selected = { ...original, evalCase: { ...original.evalCase, repeat: 1, logs: { dir: output } } };
  if (selected.evalCase.artifacts) throw new Error('artifact replay is not supported by this entry point');
  if (selected.evalCase.repo?.external) {
    const kind = config.publicRepo;
    const url = config.repositoryUrl ?? urls[kind];
    if (typeof url !== 'string' || !url) throw new Error('external case requires publicRepo or repositoryUrl');
    const oracle = path.join(suiteDir, 'oracle.md');
    const match = existsSync(oracle) ? /^pr:\s*(\d+)\s*$/mu.exec(readFileSync(oracle, 'utf8')) : null;
    const target = config.targetDir ? path.resolve(path.dirname(file), config.targetDir) : path.join(output, 'target');
    selected.evalCase.repo = { external: prepareTarget(target, url, selected.evalCase.command?.base, selected.evalCase.command?.head, match ? Number(match[1]) : undefined) };
  }
  const loaded = loadConfig({ repoRoot: suiteDir, loadRepoConfig: false });
  return runEvalCase(suite, selected, { config: loaded.config, codegenieHome: loaded.paths.home, configWarnings: loaded.warnings, cacheOverride: false,
    ...(fetchForCall !== undefined ? { fetchForCall } : {}) });
}
