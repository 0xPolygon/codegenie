import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';
import { readCheckedFile } from './safe-read.mjs';
import { projectBlindSheet, TreatmentLeakError } from './blind-sheet.mjs';
import { ROLES, neutralAnchorPath } from './blind-inputs.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export function containsSlotId(text, slotId) {
  if (typeof text !== 'string' || typeof slotId !== 'string' || !slotId) throw new Error('invalid slot identifier');
  const escaped = slotId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
}
function checkedOutside(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || outsideCheckout(value) !== value) throw new Error('invalid export path');
  return value;
}
function publish(file, bytes) {
  const temp = path.join(path.dirname(file), `.blind-${randomBytes(16).toString('hex')}`);
  try {
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, file); }
    catch (error) { if (error?.code !== 'EEXIST' || !readCheckedFile(file).equals(bytes)) throw new Error('export bytes changed'); }
    const dir = openSync(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { try { unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
}
function checkDestination(directory, expected) {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid export directory');
  for (const name of readdirSync(directory)) {
    if (/^\.blind-[a-f0-9]{32}$/u.test(name)) throw new Error('unfinished export scratch requires reconciliation');
    if (!expected.has(name)) throw new Error('unexpected export directory entry');
    if (!readCheckedFile(path.join(directory, name)).equals(expected.get(name))) throw new Error('export bytes changed');
  }
}
function opaque(key, binding, item) {
  return createHmac('sha256', key).update(JSON.stringify([binding, item.slotId, item.attempt, item.receiptSHA256])).digest('hex').slice(0, 24);
}
function neutral(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 512 && !/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('/') && !/^[a-z]:/iu.test(value) && !value.includes('\\') &&
    !value.split('/').includes('..') && !/(?:assigned.?effects|openrouter|openai|\b(?:control|treatment)\b|\barm[-_ ]|\bdraw[-_ ]|attempt[-_ ]|\bp7\.)/iu.test(value);
}

// selections must come from checkedOutcomes, never from a caller's quality score.
export function exportFirstLock({ bindingSHA256, oracleManifestSHA256, selections, excludedCount, campaignState, outputDirectory, mappingFile, expectedMappingSHA256, expectedManifestSHA256, bindPrepared }) {
  if (!validHash(bindingSHA256) || !validHash(oracleManifestSHA256) || !Array.isArray(selections) || !Number.isSafeInteger(excludedCount) || excludedCount < 0 || !(['completed', 'stopped'].includes(campaignState))) throw new Error('invalid export binding');
  const output = checkedOutside(outputDirectory), mapping = checkedOutside(mappingFile);
  if (mapping === output || mapping.startsWith(`${output}${path.sep}`) || output.startsWith(`${mapping}${path.sep}`)) throw new Error('mapping overlaps blind output');
  const descriptors = selections.map((entry) => {
    if (!entry || typeof entry.slotId !== 'string' || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || !validHash(entry.receiptSHA256) ||
        !['control', 'treatment'].includes(entry.arm) || !Number.isSafeInteger(entry.draw) || entry.draw < 1 || !neutral(entry.caseId) || !neutral(entry.sourceLocator) || !neutral(entry.oracleLocator) || !Array.isArray(entry.causes) || new Set(entry.causes.map((cause) => cause.id)).size !== entry.causes.length || entry.causes.some((cause) => !cause || !neutral(cause.id) || typeof cause.optional !== 'boolean')) throw new Error('invalid selected review');
    if (entry.role !== undefined && (!ROLES.includes(entry.role) || !Array.isArray(entry.rejects) || new Set(entry.rejects.map((reject) => reject?.id)).size !== entry.rejects.length || entry.rejects.some((reject) => !neutral(reject?.id) || !Array.isArray(reject.anchors) || !reject.anchors.length || reject.anchors.some((anchor) => !neutralAnchorPath(anchor?.path) || !Array.isArray(anchor.lineRange) || anchor.lineRange.length !== 2 || anchor.lineRange.some((line) => !Number.isSafeInteger(line) || line < 1) || anchor.lineRange[0] > anchor.lineRange[1])))) throw new Error('invalid selected review role');
    return { slotId: entry.slotId, attempt: entry.attempt, receiptSHA256: entry.receiptSHA256, arm: entry.arm, draw: entry.draw,
      caseId: entry.caseId, sourceLocator: entry.sourceLocator, oracleLocator: entry.oracleLocator, causes: entry.causes.map(({ id, optional }) => ({ id, optional })),
      ...(entry.role === undefined ? {} : { role: entry.role, rejects: entry.rejects.map(({ id, anchors }) => ({ id, anchors: anchors.map(({ path: anchorPath, lineRange }) => ({ path: anchorPath, lineRange })) })) }) };
  });
  if (new Set(descriptors.map((entry) => entry.slotId)).size !== descriptors.length) throw new Error('duplicate selected slot');
  let key;
  if (existsSync(mapping)) {
    const stat = lstatSync(mapping);
    if ((stat.mode & 0o077) !== 0) throw new Error('mapping permissions too broad');
    const prior = JSON.parse(readCheckedFile(mapping).toString('utf8'));
    if (prior.bindingSHA256 !== bindingSHA256 || prior.oracleManifestSHA256 !== oracleManifestSHA256 || prior.excludedCount !== excludedCount || prior.campaignState !== campaignState ||
        JSON.stringify(prior.selections?.map(({ id: _id, ...entry }) => entry)) !== JSON.stringify(descriptors) || !/^[a-f0-9]{64}$/u.test(prior.key ?? '')) throw new Error('blind export selection changed');
    key = Buffer.from(prior.key, 'hex');
  } else key = randomBytes(32);
  const mapped = descriptors.map((entry) => ({ ...entry, id: opaque(key, bindingSHA256, entry) }));
  if (new Set(mapped.map((entry) => entry.id)).size !== mapped.length) throw new Error('opaque identifier collision');
  const mappingBytes = json({ version: 1, bindingSHA256, oracleManifestSHA256, excludedCount, campaignState, key: key.toString('hex'), selections: mapped });
  const sheets = []; let affectedSheets = 0, hits = 0;
  for (const [index, entry] of selections.entries()) {
    const descriptor = mapped[index]; let sheet;
    try { sheet = projectBlindSheet({ ...entry.evidence, key, id: descriptor.id, caseId: descriptor.caseId }); }
    catch (error) { if (!(error instanceof TreatmentLeakError)) throw error; affectedSheets++; hits += error.hits; continue; }
    const bytes = json({ ...sheet, causes: descriptor.causes, sourceLocator: descriptor.sourceLocator, oracleLocator: descriptor.oracleLocator,
      ...(descriptor.role === undefined ? {} : { role: descriptor.role, rejects: descriptor.rejects }) });
    const visible = bytes.toString('utf8');
    const privateValues = [entry.slotId, entry.receiptSHA256, ...(entry.evidence.privateIdentifiers ?? [])].filter((value) => typeof value === 'string' && value.length >= 8);
    if (containsSlotId(visible, entry.slotId) || privateValues.some((value) => visible.includes(value)) || /(?:^|[\s"'])\/(?:home|tmp|private|Users)\//u.test(visible)) throw new Error('private identifier in first-lock sheet');
    sheets.push({ case: descriptor.caseId, id: descriptor.id, causes: descriptor.causes, terminal: entry.evidence.outcome, bytes, sha256: digest(bytes),
      ...(descriptor.role === undefined ? {} : { role: descriptor.role, rejects: descriptor.rejects }) });
  }
  if (hits) throw new TreatmentLeakError(hits, affectedSheets);
  sheets.sort((a, b) => a.case < b.case ? -1 : a.case > b.case ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const manifestBytes = json({ version: 1, campaignBinding: bindingSHA256, oracleManifestSHA256, mappingSHA256: digest(mappingBytes), campaignState, selectedCount: sheets.length, excludedCount,
    sheets: sheets.map(({ case: caseName, id, causes, terminal, sha256, role, rejects }) => ({ case: caseName, id, causes, sha256, terminal, ...(role === undefined ? {} : { role, rejects }) })) });
  if ((expectedMappingSHA256 !== undefined && digest(mappingBytes) !== expectedMappingSHA256) ||
      (expectedManifestSHA256 !== undefined && digest(manifestBytes) !== expectedManifestSHA256)) throw new Error('blind export binding changed');
  const expectedFiles = new Map(sheets.map((sheet) => [`${sheet.id}.json`, sheet.bytes]));
  expectedFiles.set('manifest.json', manifestBytes);
  checkDestination(output, expectedFiles);
  // Prepare the entire projection before publishing either the key or sheets.
  mkdirSync(path.dirname(mapping), { recursive: true, mode: 0o700 });
  publish(mapping, mappingBytes);
  if (bindPrepared !== undefined) {
    if (typeof bindPrepared !== 'function' || bindPrepared(digest(mappingBytes), digest(manifestBytes)) !== true) throw new Error('blind export binding failed');
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  if (outsideCheckout(output) !== output) throw new Error('invalid export directory');
  for (const sheet of sheets) publish(path.join(output, `${sheet.id}.json`), sheet.bytes);
  publish(path.join(output, 'manifest.json'), manifestBytes);
  return { manifestSHA256: digest(manifestBytes), mappingSHA256: digest(mappingBytes), sheetCount: sheets.length, excludedCount };
}

function readBound(file, expected) {
  if (!validHash(expected)) throw new Error('invalid evidence digest');
  const bytes = readCheckedFile(checkedOutside(file));
  if (digest(bytes) !== expected) throw new Error('export evidence digest mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

export function verifyPrimaryBundle(manifestFile, manifest, mapping) {
  if (mapping.bindingSHA256 !== manifest.campaignBinding || !Array.isArray(mapping.selections) || !Array.isArray(manifest.sheets) || !/^[a-f0-9]{64}$/u.test(mapping.key ?? '') || mapping.selections.length !== manifest.sheets.length) throw new Error('invalid first-lock manifest');
  if (path.basename(manifestFile) !== 'manifest.json') throw new Error('invalid first-lock manifest path');
  const key = Buffer.from(mapping.key, 'hex'), sheets = [], expectedFiles = new Map([['manifest.json', readCheckedFile(manifestFile)]]);
  for (const item of mapping.selections) {
    const sheet = manifest.sheets.find((entry) => entry.id === item.id);
    if (!sheet || item.id !== opaque(key, mapping.bindingSHA256, item) || !validHash(sheet.sha256)) throw new Error('first-lock sheet mismatch');
    const bytes = readCheckedFile(path.join(path.dirname(manifestFile), `${item.id}.json`));
    if (digest(bytes) !== sheet.sha256) throw new Error('first-lock sheet mismatch');
    expectedFiles.set(`${item.id}.json`, bytes);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.id !== item.id || parsed.case !== sheet.case || JSON.stringify(sheet.causes) !== JSON.stringify(item.causes) ||
        (item.role !== undefined && (sheet.role !== item.role || parsed.role !== item.role || JSON.stringify(sheet.rejects) !== JSON.stringify(item.rejects) || JSON.stringify(parsed.rejects) !== JSON.stringify(item.rejects)))) throw new Error('first-lock sheet mismatch');
    sheets.push(parsed);
  }
  checkDestination(path.dirname(manifestFile), expectedFiles);
  return sheets;
}

// Reveal pairing only after both primary grades and their reconciliation are locked.
export async function revealPairing({ manifestFile, manifestSHA256, mappingFile, locks, reconciliation, outputFile, expectedReconciliationSHA256, bindPrepared }) {
  const { verifyPrimaryLocks } = await import('./blind-locks.mjs');
  const manifest = readBound(manifestFile, manifestSHA256);
  if ((lstatSync(checkedOutside(mappingFile)).mode & 0o077) !== 0) throw new Error('mapping permissions too broad');
  const mappingBytes = readCheckedFile(checkedOutside(mappingFile));
  if (digest(mappingBytes) !== manifest.mappingSHA256) throw new Error('mapping binding mismatch');
  const mapping = JSON.parse(mappingBytes.toString('utf8'));
  const sheets = verifyPrimaryBundle(manifestFile, manifest, mapping);
  const { reconciliationSHA256 } = verifyPrimaryLocks({ manifestSHA256, locks, reconciliation, manifest, sheets });
  if (expectedReconciliationSHA256 !== undefined && expectedReconciliationSHA256 !== reconciliationSHA256) throw new Error('reconciliation binding changed');
  const output = checkedOutside(outputFile);
  if (output === mappingFile || output.startsWith(`${path.dirname(manifestFile)}${path.sep}`)) throw new Error('reveal overlaps protected evidence');
  const bytes = json({ version: 1, manifestSHA256, reconciliationSHA256,
    reviews: mapping.selections.map((item) => ({ id: item.id, case: item.caseId, arm: item.arm, draw: item.draw })) });
  if (bindPrepared !== undefined && (typeof bindPrepared !== 'function' || bindPrepared(reconciliationSHA256) !== true)) throw new Error('reconciliation binding failed');
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  publish(output, bytes);
  return { revealSHA256: digest(bytes), reviewCount: mapping.selections.length };
}
