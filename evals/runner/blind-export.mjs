import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideCheckout } from './case.mjs';
import { readCheckedFile } from './safe-read.mjs';
import { projectBlindSheet } from './blind-sheet.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
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
function opaque(key, binding, item) {
  return createHmac('sha256', key).update(JSON.stringify([binding, item.slotId, item.attempt, item.receiptSHA256])).digest('hex').slice(0, 24);
}
function neutral(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 512 && !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').includes('..') && !/(?:assigned.?effects|openrouter|openai|\b(?:control|treatment)\b|\barm[-_ ]|\bdraw[-_ ]|attempt[-_ ]|\bp7\.)/iu.test(value);
}

// selections must come from checkedOutcomes, never from a caller's quality score.
export function exportFirstLock({ bindingSHA256, oracleManifestSHA256, selections, excludedCount, campaignState, outputDirectory, mappingFile, expectedMappingSHA256, expectedManifestSHA256, bindPrepared }) {
  if (!validHash(bindingSHA256) || !validHash(oracleManifestSHA256) || !Array.isArray(selections) || !Number.isSafeInteger(excludedCount) || excludedCount < 0 || !(['completed', 'stopped'].includes(campaignState))) throw new Error('invalid export binding');
  const output = checkedOutside(outputDirectory), mapping = checkedOutside(mappingFile);
  if (mapping === output || mapping.startsWith(`${output}${path.sep}`) || output.startsWith(`${mapping}${path.sep}`)) throw new Error('mapping overlaps blind output');
  const descriptors = selections.map((entry) => {
    if (!entry || typeof entry.slotId !== 'string' || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || !validHash(entry.receiptSHA256) ||
        !['control', 'treatment'].includes(entry.arm) || !Number.isSafeInteger(entry.draw) || entry.draw < 1 || !neutral(entry.caseId) || !neutral(entry.sourceLocator) || !neutral(entry.oracleLocator)) throw new Error('invalid selected review');
    return { slotId: entry.slotId, attempt: entry.attempt, receiptSHA256: entry.receiptSHA256, arm: entry.arm, draw: entry.draw,
      caseId: entry.caseId, sourceLocator: entry.sourceLocator, oracleLocator: entry.oracleLocator };
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
  const sheets = selections.map((entry, index) => {
    const descriptor = mapped[index], sheet = projectBlindSheet({ ...entry.evidence, key, id: descriptor.id, caseId: descriptor.caseId });
    const bytes = json({ ...sheet, sourceLocator: descriptor.sourceLocator, oracleLocator: descriptor.oracleLocator });
    const visible = bytes.toString('utf8');
    const privateValues = [entry.slotId, entry.receiptSHA256, ...(entry.evidence.privateIdentifiers ?? [])].filter((value) => typeof value === 'string' && value.length >= 8);
    if (privateValues.some((value) => visible.includes(value)) || /(?:^|[\s"'])\/(?:home|tmp|private|Users)\//u.test(visible)) throw new Error('private identifier in first-lock sheet');
    return { case: descriptor.caseId, id: descriptor.id, terminal: entry.evidence.outcome, bytes, sha256: digest(bytes) };
  }).sort((a, b) => a.case < b.case ? -1 : a.case > b.case ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const manifestBytes = json({ version: 1, campaignBinding: bindingSHA256, oracleManifestSHA256, mappingSHA256: digest(mappingBytes), campaignState, selectedCount: sheets.length, excludedCount,
    sheets: sheets.map(({ case: caseName, id, terminal, sha256 }) => ({ case: caseName, id, sha256, terminal })) });
  if ((expectedMappingSHA256 !== undefined && digest(mappingBytes) !== expectedMappingSHA256) ||
      (expectedManifestSHA256 !== undefined && digest(manifestBytes) !== expectedManifestSHA256)) throw new Error('blind export binding changed');
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

// The caller supplies receipt-verified artifacts for precisely the mapped cohort.
// All checks and projections precede creation of any mechanism output.
export async function exportMechanism({ manifestFile, manifestSHA256, mappingFile, locks, reconciliation, evidence, outputDirectory }) {
  const { verifyPrimaryLocks } = await import('./blind-locks.mjs');
  const { projectMechanism } = await import('./blind-mechanism.mjs');
  const manifest = readBound(manifestFile, manifestSHA256);
  if ((lstatSync(checkedOutside(mappingFile)).mode & 0o077) !== 0) throw new Error('mapping permissions too broad');
  const mappingBytes = readCheckedFile(checkedOutside(mappingFile));
  if (digest(mappingBytes) !== manifest.mappingSHA256) throw new Error('mapping binding mismatch');
  const mapping = JSON.parse(mappingBytes.toString('utf8'));
  if (mapping.bindingSHA256 !== manifest.campaignBinding || !Array.isArray(mapping.selections) || !Array.isArray(manifest.sheets) || !/^[a-f0-9]{64}$/u.test(mapping.key ?? '') || mapping.selections.length !== manifest.sheets.length) throw new Error('invalid first-lock manifest');
  const key = Buffer.from(mapping.key, 'hex');
  for (const item of mapping.selections) {
    const sheet = manifest.sheets.find((entry) => entry.id === item.id);
    if (!sheet || item.id !== opaque(key, mapping.bindingSHA256, item) || !validHash(sheet.sha256) || digest(readCheckedFile(path.join(path.dirname(manifestFile), `${item.id}.json`))) !== sheet.sha256) throw new Error('first-lock sheet mismatch');
  }
  verifyPrimaryLocks({ manifestSHA256, locks, reconciliation });
  const selected = mapping.selections.filter((item) => item.arm === 'treatment');
  if (!Array.isArray(evidence) || evidence.length !== selected.length || new Set(evidence.map((item) => item.id)).size !== selected.length ||
      selected.some((item) => !manifest.sheets.some((sheet) => sheet.id === item.id) || !evidence.some((entry) => entry.id === item.id))) throw new Error('mechanism cohort mismatch');
  const projections = selected.map((item) => {
    const source = evidence.find((entry) => entry.id === item.id);
    if (!source || source.receiptSHA256 !== item.receiptSHA256) throw new Error('mechanism receipt mismatch');
    const bytes = json(projectMechanism({ id: item.id, records: source.records, packets: source.packets }));
    return { id: item.id, bytes, sha256: digest(bytes) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const output = checkedOutside(outputDirectory);
  const firstLockDirectory = path.dirname(checkedOutside(manifestFile)), mappingPath = checkedOutside(mappingFile);
  if (output === firstLockDirectory || output.startsWith(`${firstLockDirectory}${path.sep}`) || mappingPath === output || mappingPath.startsWith(`${output}${path.sep}`)) throw new Error('mechanism output overlaps protected files');
  const bytes = json({ version: 1, firstLockManifestSHA256: manifestSHA256, reconciliationSHA256: reconciliation.sha256,
    reviews: projections.map(({ id, sha256 }) => ({ id, sha256 })) });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const projection of projections) publish(path.join(output, `${projection.id}.json`), projection.bytes);
  publish(path.join(output, 'manifest.json'), bytes);
  return { mechanismManifestSHA256: digest(bytes), reviewCount: projections.length };
}

// Pairing is released only after primary reconciliation and frozen mechanism
// coding. The analyst-facing output never contains the export key or receipts.
export async function revealPairing({ manifestFile, manifestSHA256, mappingFile, locks, reconciliation, mechanismManifestFile, mechanismManifestSHA256, coding, outputFile }) {
  const { verifyPrimaryLocks, verifyMechanismFreeze } = await import('./blind-locks.mjs');
  const manifest = readBound(manifestFile, manifestSHA256);
  if ((lstatSync(checkedOutside(mappingFile)).mode & 0o077) !== 0) throw new Error('mapping permissions too broad');
  const mappingBytes = readCheckedFile(checkedOutside(mappingFile));
  if (digest(mappingBytes) !== manifest.mappingSHA256) throw new Error('mapping binding mismatch');
  const mapping = JSON.parse(mappingBytes.toString('utf8'));
  verifyPrimaryLocks({ manifestSHA256, locks, reconciliation });
  const mechanism = readBound(mechanismManifestFile, mechanismManifestSHA256);
  if (mechanism.firstLockManifestSHA256 !== manifestSHA256 || mechanism.reconciliationSHA256 !== reconciliation.sha256 || !Array.isArray(mechanism.reviews)) throw new Error('mechanism manifest mismatch');
  const expected = mapping.selections.filter((item) => item.arm === 'treatment').map((item) => item.id).sort();
  if (mechanism.reviews.length !== expected.length || mechanism.reviews.map((item) => item.id).sort().join(',') !== expected.join(',')) throw new Error('mechanism cohort mismatch');
  for (const item of mechanism.reviews) {
    if (!/^[a-f0-9]{24}$/u.test(item.id ?? '') || !validHash(item.sha256) || digest(readCheckedFile(path.join(path.dirname(mechanismManifestFile), `${item.id}.json`))) !== item.sha256) throw new Error('mechanism review changed');
  }
  verifyMechanismFreeze({ mechanismManifestSHA256, coding });
  const output = checkedOutside(outputFile);
  if (output === mappingFile || output.startsWith(`${path.dirname(manifestFile)}${path.sep}`) || output.startsWith(`${path.dirname(mechanismManifestFile)}${path.sep}`)) throw new Error('reveal overlaps protected evidence');
  const bytes = json({ version: 1, manifestSHA256, mechanismManifestSHA256, codingSHA256: coding.sha256,
    reviews: mapping.selections.map((item) => ({ id: item.id, case: item.caseId, arm: item.arm, draw: item.draw })) });
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  publish(output, bytes);
  return { revealSHA256: digest(bytes), reviewCount: mapping.selections.length };
}
