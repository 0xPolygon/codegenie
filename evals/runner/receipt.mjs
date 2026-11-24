import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeSlot = (slot) => typeof slot === 'string' && /^[A-Za-z0-9._-]+$/u.test(slot) && !['.', '..'].includes(slot);
const safeHash = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash);

// Receipt bytes name every file, including debug streams. The full inventory is
// checked again at every use so an added, changed, or removed artifact fails.
function inventory(directory) {
  const root = outsideCheckout(directory);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('invalid receipt artifact root');
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(dir, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('symlink in receipt artifacts');
      if (stat.isDirectory()) walk(file, relative);
      else if (stat.isFile()) {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes;
        try { bytes = readFileSync(fd); } finally { closeSync(fd); }
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      } else throw new Error('invalid receipt artifact');
    }
  };
  walk(root);
  return files;
}

// The caller supplies a run directory already validated against workerBounds.
// Receipts live separately, with exclusive content-addressed publication.
export function createReceiptStore({ directory, binding, runRootFor }) {
  if (typeof binding !== 'string' || !binding || typeof runRootFor !== 'function') throw new Error('invalid receipt binding');
  const root = outsideCheckout(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error('invalid receipt directory');
  const fileFor = (hash) => path.join(root, hash);
  const verify = (slot, attempt, hash) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1 || !safeHash(hash)) return false;
    try {
      const fd = openSync(fileFor(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try { bytes = readFileSync(fd); } finally { closeSync(fd); }
      if (digest(bytes) !== hash) return false;
      const receipt = JSON.parse(bytes.toString('utf8'));
      if (receipt.version !== 1 || receipt.binding !== binding || receipt.slot !== slot || receipt.attempt !== attempt ||
          !['pass', 'fail', 'error'].includes(receipt.status) || typeof receipt.caseName !== 'string' || !receipt.caseName || typeof receipt.runDir !== 'string') return false;
      const allowed = outsideCheckout(runRootFor(slot, attempt));
      const runDir = outsideCheckout(receipt.runDir);
      if (!runDir.startsWith(allowed + path.sep) || realpathSync(runDir) !== runDir) return false;
      return JSON.stringify(receipt.files) === JSON.stringify(inventory(runDir));
    } catch { return false; }
  };
  const seal = (slot, attempt, result) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1 || !result || !['pass', 'fail', 'error'].includes(result.status) || typeof result.caseName !== 'string' || !result.caseName || typeof result.runDir !== 'string') throw new Error('invalid receipt result');
    const allowed = outsideCheckout(runRootFor(slot, attempt)), runDir = outsideCheckout(result.runDir);
    if (!runDir.startsWith(allowed + path.sep) || realpathSync(runDir) !== runDir) throw new Error('receipt outside attempt root');
    const errors = ['campaign_budget', 'binding_mismatch', 'provider_denied', 'provider_failure', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted', 'unclassified'];
    if (result.status === 'error' && !errors.includes(result.error)) throw new Error('invalid receipt error');
    const record = { version: 1, binding, slot, attempt, caseName: result.caseName, status: result.status,
      ...(result.status === 'error' ? { error: result.error } : {}), runDir, files: inventory(runDir) };
    const bytes = Buffer.from(JSON.stringify(record)), hash = digest(bytes);
    try {
      const fd = openSync(fileFor(hash), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      const dirfd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
    } catch (error) {
      if (error?.code !== 'EEXIST' || !verify(slot, attempt, hash)) throw error;
    }
    if (!verify(slot, attempt, hash)) throw new Error('receipt verification failed');
    return hash;
  };
  const find = (slot, attempt) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid receipt identity');
    const found = [];
    for (const hash of readdirSync(root).filter(safeHash)) {
      const fd = openSync(fileFor(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try { bytes = readFileSync(fd); } finally { closeSync(fd); }
      if (digest(bytes) !== hash) throw new Error('receipt digest mismatch');
      const receipt = JSON.parse(bytes.toString('utf8'));
      if (receipt.binding !== binding) throw new Error('receipt binding mismatch');
      if (receipt.slot === slot && receipt.attempt === attempt) {
        if (!verify(slot, attempt, hash)) throw new Error('attempt receipt missing or changed');
        found.push({ hash, receipt });
      }
    }
    if (found.length > 1) throw new Error('multiple attempt receipts');
    return found[0] ?? null;
  };
  return { seal, verify, find };
}
