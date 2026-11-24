import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';
import { readCheckedFile } from './safe-read.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeSlot = (slot) => typeof slot === 'string' && /^[A-Za-z0-9._-]+$/u.test(slot) && !['.', '..'].includes(slot);
const safeHash = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash);
const errors = new Set(['campaign_budget', 'binding_mismatch', 'provider_denied', 'provider_failure', 'accounting_failed', 'campaign_stopped', 'boundary_not_admitted', 'unclassified']);
function checkedPath(value) {
  const original = path.resolve(value);
  if (realpathSync(original) !== original || outsideCheckout(original) !== original) throw new Error('symlinked or invalid receipt path');
  return original;
}
function readSafe(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

// Receipt bytes name every file, including debug streams. The full inventory is
// checked again at every use so an added, changed, or removed artifact fails.
function inventory(directory) {
  const root = checkedPath(directory);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('invalid receipt artifact root');
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const stat of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = stat.name, relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(dir, name);
      if (stat.isSymbolicLink()) throw new Error('symlink in receipt artifacts');
      if (stat.isDirectory()) walk(file, relative);
      else if (stat.isFile()) {
        const bytes = readCheckedFile(file);
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      } else throw new Error('invalid receipt artifact');
    }
  };
  walk(root);
  return files;
}

function freeze(directory) {
  const walk = (dir) => {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('symlink in receipt artifacts');
    if (stat.isDirectory()) for (const name of readdirSync(dir)) walk(path.join(dir, name));
    else if (!stat.isFile()) throw new Error('invalid receipt artifact');
    chmodSync(dir, stat.mode & 0o555);
  };
  walk(directory);
}

// The caller supplies a run directory already validated against workerBounds.
// A single exclusive attempt file is the authoritative receipt.
export function createReceiptStore({ directory, binding, runRootFor, create = false }) {
  if (typeof binding !== 'string' || !binding || typeof runRootFor !== 'function' || typeof create !== 'boolean') throw new Error('invalid receipt binding');
  const unresolvedRoot = path.resolve(directory);
  outsideCheckout(unresolvedRoot);
  if (create) mkdirSync(unresolvedRoot, { recursive: true, mode: 0o700 });
  const root = checkedPath(unresolvedRoot);
  const identity = lstatSync(root);
  if (!identity.isDirectory()) throw new Error('invalid receipt directory');
  const pointerFor = (slot, attempt) => path.join(root, `attempt-${digest(JSON.stringify([binding, slot, attempt]))}`);
  const publish = (file, bytes) => {
    const temporary = path.join(root, `.tmp-${randomBytes(16).toString('hex')}`);
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temporary, file); }
      catch (error) {
        if (error?.code !== 'EEXIST' || !readSafe(file).equals(bytes)) throw new Error('conflicting receipt publication');
      }
      const dirfd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
    } finally { try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  };
  if (create) publish(path.join(root, '.campaign'), Buffer.from(binding));
  const assertStore = () => {
    try {
      const stat = lstatSync(checkedPath(root));
      if (!stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino || readSafe(path.join(root, '.campaign')).toString('utf8') !== binding) throw new Error('invalid');
    } catch { throw new Error('receipt store custody failure'); }
  };
  assertStore();
  const readVerified = (slot, attempt, hash) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1 || !safeHash(hash)) return false;
    try {
      assertStore();
      const bytes = readSafe(pointerFor(slot, attempt));
      if (digest(bytes) !== hash) return false;
      const receipt = JSON.parse(bytes.toString('utf8'));
      if (receipt.version !== 1 || receipt.binding !== binding || receipt.slot !== slot || receipt.attempt !== attempt ||
          !['pass', 'fail', 'error', 'stop'].includes(receipt.status) || typeof receipt.caseName !== 'string' || !receipt.caseName || typeof receipt.caseId !== 'string' || !receipt.caseId || typeof receipt.runDir !== 'string') return false;
      if (receipt.status === 'stop' ? (receipt.reason !== 'terminal_evidence' || receipt.recoveredResets !== null || receipt.error !== undefined) : (!Number.isSafeInteger(receipt.recoveredResets) || receipt.recoveredResets < 0 || (receipt.status === 'error' ? !errors.has(receipt.error) : receipt.error !== undefined))) return false;
      if (receipt.failureCallId !== undefined && (receipt.status !== 'error' || receipt.error !== 'provider_failure' || typeof receipt.failureCallId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(receipt.failureCallId))) return false;
      const allowed = checkedPath(runRootFor(slot, attempt));
      const runDir = checkedPath(receipt.runDir);
      if (!runDir.startsWith(allowed + path.sep) || realpathSync(runDir) !== runDir) return false;
      return JSON.stringify(receipt.files) === JSON.stringify(inventory(runDir)) ? receipt : false;
    } catch { return false; }
  };
  const verify = (slot, attempt, hash) => {
    try { return readVerified(slot, attempt, hash) !== false; }
    catch { return false; }
  };
  const seal = (slot, attempt, result) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1 || !result || !['pass', 'fail', 'error'].includes(result.status) || typeof result.caseName !== 'string' || !result.caseName || typeof result.runDir !== 'string') throw new Error('invalid receipt result');
    const allowed = checkedPath(runRootFor(slot, attempt)), runDir = checkedPath(result.runDir);
    if (!runDir.startsWith(allowed + path.sep) || realpathSync(runDir) !== runDir) throw new Error('receipt outside attempt root');
    if (result.status === 'error' && !errors.has(result.error)) throw new Error('invalid receipt error');
    if (result.failureCallId !== undefined && (result.status !== 'error' || result.error !== 'provider_failure' || typeof result.failureCallId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(result.failureCallId))) throw new Error('invalid failure identity');
    const { caseId, recoveredResets } = result;
    if (typeof caseId !== 'string' || !caseId || !Number.isSafeInteger(recoveredResets) || recoveredResets < 0) throw new Error('invalid receipt case evidence');
    assertStore();
    const record = { version: 1, binding, slot, attempt, caseName: result.caseName, caseId, recoveredResets, status: result.status,
      ...(result.status === 'error' ? { error: result.error, ...(result.failureCallId !== undefined ? { failureCallId: result.failureCallId } : {}) } : {}), runDir, files: inventory(runDir) };
    const bytes = Buffer.from(JSON.stringify(record)), hash = digest(bytes);
    freeze(runDir);
    publish(pointerFor(slot, attempt), bytes);
    if (!verify(slot, attempt, hash)) throw new Error('receipt verification failed');
    return hash;
  };
  const sealStop = (slot, attempt, result) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1 || typeof result?.caseName !== 'string' || !result.caseName || typeof result.caseId !== 'string' || !result.caseId || typeof result.runDir !== 'string') throw new Error('invalid stop receipt');
    const allowed = checkedPath(runRootFor(slot, attempt)), runDir = checkedPath(result.runDir);
    if (!runDir.startsWith(allowed + path.sep)) throw new Error('receipt outside attempt root');
    assertStore();
    const bytes = Buffer.from(JSON.stringify({ version: 1, binding, slot, attempt, caseName: result.caseName, caseId: result.caseId,
      recoveredResets: null, status: 'stop', reason: 'terminal_evidence', runDir, files: inventory(runDir) }));
    const hash = digest(bytes);
    freeze(runDir); publish(pointerFor(slot, attempt), bytes);
    if (!verify(slot, attempt, hash)) throw new Error('stop receipt verification failed');
    return hash;
  };
  const find = (slot, attempt) => {
    if (!safeSlot(slot) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid receipt identity');
    assertStore();
    let bytes;
    try { bytes = readSafe(pointerFor(slot, attempt)); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      assertStore();
      return null;
    }
    const hash = digest(bytes);
    if (!verify(slot, attempt, hash)) throw new Error('attempt receipt missing or changed');
    return { hash, receipt: JSON.parse(bytes.toString('utf8')) };
  };
  return { seal, sealStop, verify, find };
}
