import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCheckedFile } from './safe-read.mjs';

const checkout = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Hash the full relative inventory and each file's bytes. Symlinks fail closed.
export function treeDigest(directory) {
  const root = path.resolve(directory);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('invalid integrity root');
  const entries = [];
  const visit = (dir, prefix = '') => {
    for (const stat of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = stat.name, relative = prefix ? `${prefix}/${name}` : name, file = path.join(dir, name);
      if (stat.isSymbolicLink()) throw new Error('symlink in integrity tree');
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile()) { const bytes = readCheckedFile(file); entries.push([relative, bytes.length, digest(bytes)]); }
      else throw new Error('unsupported integrity entry');
    }
  };
  visit(root);
  return digest(JSON.stringify(entries));
}
export function buildDigest() {
  const pi = realpathSync(path.join(checkout, 'node_modules/@earendil-works/pi-ai'));
  return { dist: treeDigest(path.join(checkout, 'dist')), runner: treeDigest(path.join(checkout, 'evals/runner')),
    skills: treeDigest(path.join(checkout, 'bundled-skills')), grammars: treeDigest(path.join(checkout, 'bundled-grammars')),
    models: digest(readFileSync(path.join(checkout, 'models.md'))), pi: treeDigest(path.join(pi, 'dist')), piPackage: digest(readFileSync(path.join(pi, 'package.json'))),
    lockfile: digest(readFileSync(path.join(checkout, 'pnpm-lock.yaml'))), package: digest(readFileSync(path.join(checkout, 'package.json'))) };
}
export function assertIntegrity(integrity) {
  if (!integrity || typeof integrity.suiteDir !== 'string' || typeof integrity.suiteSHA256 !== 'string' || !integrity.build) throw new Error('campaign input binding mismatch');
  const actual = buildDigest();
  if (Object.keys(integrity.build).length !== Object.keys(actual).length || Object.keys(actual).some((key) => integrity.build[key] !== actual[key]) || treeDigest(integrity.suiteDir) !== integrity.suiteSHA256) throw new Error('campaign input binding mismatch');
}
