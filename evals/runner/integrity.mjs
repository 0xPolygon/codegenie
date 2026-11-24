import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Hash the full relative inventory and each file's bytes. Symlinks fail closed.
export function treeDigest(directory) {
  const root = path.resolve(directory);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('invalid integrity root');
  const entries = [];
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, file = path.join(dir, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('symlink in integrity tree');
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile()) entries.push([relative, stat.size, digest(readFileSync(file))]);
      else throw new Error('unsupported integrity entry');
    }
  };
  visit(root);
  return digest(JSON.stringify(entries));
}
export function buildDigest() {
  return { dist: treeDigest(path.join(checkout, 'dist')), runner: treeDigest(path.join(checkout, 'evals/runner')),
    lockfile: digest(readFileSync(path.join(checkout, 'pnpm-lock.yaml'))), package: digest(readFileSync(path.join(checkout, 'package.json'))) };
}
export function assertIntegrity(integrity) {
  if (!integrity || typeof integrity.suiteDir !== 'string' || typeof integrity.suiteSHA256 !== 'string' || !integrity.build) throw new Error('campaign input binding mismatch');
  const actual = buildDigest();
  if (Object.keys(integrity.build).length !== 4 || Object.keys(actual).some((key) => integrity.build[key] !== actual[key]) || treeDigest(integrity.suiteDir) !== integrity.suiteSHA256) throw new Error('campaign input binding mismatch');
}
