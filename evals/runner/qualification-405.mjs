import { createHash } from 'node:crypto';

export const ASSIGNED_EFFECTS_PLAN_SHA256 = 'c9ed7a824385a3da63c6363dcbb8a61a1536c6ea5389bfcd15906cc6e33393b7';

// This is an offline binding check, not authorization to dispatch a campaign.
// `caseIds` must come from the separately hashed registered case manifest.
export function validate405Schedule({ scheduleBytes, scheduleSHA256, caseIds, seed, planSHA256, verifierConcurrency }) {
  if (!Buffer.isBuffer(scheduleBytes) || !/^[a-f0-9]{64}$/u.test(scheduleSHA256 ?? '') || createHash('sha256').update(scheduleBytes).digest('hex') !== scheduleSHA256) throw new Error('405 schedule digest mismatch');
  const schedule = JSON.parse(scheduleBytes.toString('utf8'));
  if (planSHA256 !== ASSIGNED_EFFECTS_PLAN_SHA256 || verifierConcurrency !== 'native' || seed !== '405-dev20-c9ed7a82' ||
      !Array.isArray(caseIds) || caseIds.length !== 20 || new Set(caseIds).size !== 20 || caseIds.some((id) => typeof id !== 'string' || !id || /[\u0000-\u001f\u007f]/u.test(id)) ||
      !schedule || schedule.seed !== seed || schedule.verifierConcurrency !== 'native' || !Array.isArray(schedule.slots) || schedule.slots.length !== 80) throw new Error('invalid 405 registration');
  const rank = (id) => createHash('sha256').update(seed, 'utf8').update(id, 'utf8').digest('hex');
  const registeredOrder = [...caseIds].sort((a, b) => { const x = rank(a), y = rank(b); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; });
  let firstControlCount = 0;
  const slotIds = new Set();
  for (let i = 0; i < caseIds.length; i++) {
    const chunk = schedule.slots.slice(i * 4, i * 4 + 4);
    const first = chunk[0]?.blind?.arm;
    if (first !== (i % 2 === 0 ? 'control' : 'treatment')) throw new Error('405 schedule order mismatch');
    if (first === 'control') firstControlCount++;
    const order = first === 'control' ? ['control', 'treatment'] : ['treatment', 'control'];
    const wanted = [{ arm: order[0], draw: 1 }, { arm: order[1], draw: 1 }, { arm: order[1], draw: 2 }, { arm: order[0], draw: 2 }];
    for (let j = 0; j < 4; j++) {
      const slot = chunk[j], arm = wanted[j].arm;
      if (!slot || slot.caseId !== registeredOrder[i] || slot.blind?.arm !== arm || slot.blind?.draw !== wanted[j].draw || typeof slot.id !== 'string' || !slot.id || slotIds.has(slot.id) || slot.workerConfig?.assignedEffects !== (arm === 'treatment')) throw new Error('405 schedule order mismatch');
      slotIds.add(slot.id);
    }
  }
  if (firstControlCount !== 10) throw new Error('405 schedule balance mismatch');
  if (schedule.pauseAfterSlot !== schedule.slots[7].id) throw new Error('405 checkpoint mismatch');
  return { slots: 80, cases: 20, checkpointSlots: 8, verifierConcurrency: 'native' };
}

export const ASSIGNED_EFFECTS_SEED = '405-dev20-c9ed7a82';
export const ASSIGNED_EFFECTS_ORDER_RULE = 'Sort case IDs by SHA-256(UTF-8 seed || UTF-8 case ID); draw 1 control first on even ranks and treatment first on odd ranks; reverse within each case on draw 2; emit four contiguous slots per case.';

// Derive anchor overlap from bound oracle anchors and the exact raw diffs.
// This mapping is diagnostic only; it never restricts an effect match.
export async function derive405AnchorMappings({ oracleManifestPath, oracleManifestSHA256, diffSources }) {
  const { readCheckedFile } = await import('./safe-read.mjs');
  const { parseDiff } = await import('../../dist/git/diff-parser.js');
  if (typeof oracleManifestPath !== 'string' || !/^[a-f0-9]{64}$/u.test(oracleManifestSHA256 ?? '') || !Array.isArray(diffSources)) throw new Error('invalid 405 source binding');
  const oracleBytes = readCheckedFile(oracleManifestPath);
  if (createHash('sha256').update(oracleBytes).digest('hex') !== oracleManifestSHA256) throw new Error('405 oracle binding mismatch');
  const oracle = JSON.parse(oracleBytes.toString('utf8'));
  if (!Array.isArray(oracle.cases) || oracle.cases.length !== 20 || new Set(oracle.cases.map((item) => item.caseId)).size !== 20 || diffSources.length !== 20 ||
      new Set(diffSources.map((item) => item.caseId)).size !== 20 || oracle.cases.some((item) => !diffSources.some((source) => source.caseId === item.caseId))) throw new Error('405 case membership mismatch');
  return oracle.cases.map((item) => {
    const source = diffSources.find((entry) => entry.caseId === item.caseId);
    if (!source || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256 ?? '') || !Array.isArray(item.causes) || new Set(item.causes.map((cause) => cause.id)).size !== item.causes.length) throw new Error('invalid 405 diff binding');
    const bytes = readCheckedFile(source.path);
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256 || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error('405 diff binding mismatch');
    const diff = parseDiff(bytes.toString('utf8'));
    const causes = item.causes.map((cause) => {
      if (!cause || typeof cause.id !== 'string' || !cause.id || typeof cause.optional !== 'boolean' || !Array.isArray(cause.anchors)) throw new Error('invalid 405 oracle cause');
      const matched = new Set();
      for (const anchor of cause.anchors) {
        if (!anchor || typeof anchor.path !== 'string' || !Array.isArray(anchor.lineRange) || anchor.lineRange.length !== 2 || !anchor.lineRange.every((line) => Number.isSafeInteger(line) && line > 0) || anchor.lineRange[0] > anchor.lineRange[1]) throw new Error('invalid 405 oracle anchor');
        for (const file of diff.files) {
          // Oracle anchors refer to the introducing commit, where a deleted
          // path has no location. Deletions in surviving paths point at the
          // insertion gap in head coordinates, never at their base line.
          if (file.status === 'deleted' || file.path !== anchor.path) continue;
          for (const hunk of file.hunks) {
            const overlaps = hunk.lines.some((line, index) => {
              let number;
              if (line.kind === 'add') number = line.newLineNumber;
              else if (line.kind === 'delete') {
                const next = hunk.lines.slice(index + 1).find((item) => item.newLineNumber !== undefined);
                const previous = hunk.lines.slice(0, index).reverse().find((item) => item.newLineNumber !== undefined);
                number = next?.newLineNumber ?? (previous ? previous.newLineNumber + 1 : hunk.newStart + (hunk.newLines === 0 ? 1 : 0));
              }
              return number !== undefined && number >= anchor.lineRange[0] && number <= anchor.lineRange[1];
            });
            if (overlaps) matched.add(hunk.id);
          }
        }
      }
      const hunkIds = [...matched].sort();
      return { id: cause.id, optional: cause.optional, hunkIds, unmapped: hunkIds.length === 0 };
    });
    return { caseId: item.caseId, diffPath: source.path, diffSHA256: source.sha256, causes };
  }).sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
}

// Seal the seed, oracle and mechanically derived anchor diagnostics before
// generating a schedule or dispatching a slot.
export async function seal405Registration({ file, caseIds, oracleManifestPath, oracleManifestSHA256, diffSources }) {
  const { constants, closeSync, fsyncSync, openSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { outsideCheckout } = await import('./case.mjs');
  if (typeof file !== 'string' || outsideCheckout(file) !== file || !Array.isArray(caseIds) || caseIds.length !== 20 || new Set(caseIds).size !== 20 || caseIds.some((id) => typeof id !== 'string' || !id || /[\u0000-\u001f\u007f]/u.test(id))) throw new Error('invalid 405 registration');
  const cases = await derive405AnchorMappings({ oracleManifestPath, oracleManifestSHA256, diffSources });
  if (cases.map((item) => item.caseId).join('\0') !== [...caseIds].sort().join('\0')) throw new Error('405 case membership mismatch');
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, planSHA256: ASSIGNED_EFFECTS_PLAN_SHA256, seed: ASSIGNED_EFFECTS_SEED, algorithm: ASSIGNED_EFFECTS_ORDER_RULE,
    verifierConcurrency: 'native', oracleManifestPath, oracleManifestSHA256, caseIds: [...caseIds].sort(), cases })}\n`);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const dirfd = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  return createHash('sha256').update(bytes).digest('hex');
}

export async function generate405Order({ registrationFile, registrationSHA256 }) {
  const { readCheckedFile } = await import('./safe-read.mjs');
  const { outsideCheckout } = await import('./case.mjs');
  if (typeof registrationFile !== 'string' || outsideCheckout(registrationFile) !== registrationFile || !/^[a-f0-9]{64}$/u.test(registrationSHA256 ?? '')) throw new Error('invalid 405 registration');
  const bytes = readCheckedFile(registrationFile);
  if (createHash('sha256').update(bytes).digest('hex') !== registrationSHA256) throw new Error('405 registration changed');
  const record = JSON.parse(bytes.toString('utf8'));
  if (record.version !== 1 || record.planSHA256 !== ASSIGNED_EFFECTS_PLAN_SHA256 || record.seed !== ASSIGNED_EFFECTS_SEED || record.algorithm !== ASSIGNED_EFFECTS_ORDER_RULE ||
      record.verifierConcurrency !== 'native' || !/^[a-f0-9]{64}$/u.test(record.oracleManifestSHA256 ?? '') || !Array.isArray(record.caseIds) || record.caseIds.length !== 20 ||
      new Set(record.caseIds).size !== 20 || record.caseIds.some((id) => typeof id !== 'string' || !id || /[\u0000-\u001f\u007f]/u.test(id))) throw new Error('invalid 405 registration');
  if (typeof record.oracleManifestPath !== 'string' || !Array.isArray(record.cases) || record.cases.length !== 20) throw new Error('invalid 405 registration');
  const recomputed = await derive405AnchorMappings({ oracleManifestPath: record.oracleManifestPath, oracleManifestSHA256: record.oracleManifestSHA256,
    diffSources: record.cases.map((item) => ({ caseId: item.caseId, path: item.diffPath, sha256: item.diffSHA256 })) });
  if (JSON.stringify(recomputed) !== JSON.stringify(record.cases) || recomputed.map((item) => item.caseId).join('\0') !== [...record.caseIds].sort().join('\0')) throw new Error('405 anchor mapping changed');
  const rank = (id) => createHash('sha256').update(record.seed, 'utf8').update(id, 'utf8').digest('hex');
  const caseIds = [...record.caseIds].sort((a, b) => { const x = rank(a), y = rank(b); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; });
  const slots = caseIds.flatMap((caseId, index) => {
    const first = index % 2 === 0 ? 'control' : 'treatment', second = first === 'control' ? 'treatment' : 'control';
    return [{ caseId, arm: first, draw: 1 }, { caseId, arm: second, draw: 1 }, { caseId, arm: second, draw: 2 }, { caseId, arm: first, draw: 2 }];
  });
  return { caseIds, slots, registrationSHA256, seed: record.seed, algorithm: record.algorithm, cases: recomputed, oracleManifestSHA256: record.oracleManifestSHA256 };
}
