import { createHash } from 'node:crypto';

export const ASSIGNED_EFFECTS_PLAN_SHA256 = 'c9ed7a824385a3da63c6363dcbb8a61a1536c6ea5389bfcd15906cc6e33393b7';

// This is an offline binding check, not authorization to dispatch a campaign.
// `caseIds` must come from the separately hashed registered case manifest.
export function validate405Schedule({ scheduleBytes, scheduleSHA256, caseIds, seed, planSHA256, verifierConcurrency }) {
  if (!Buffer.isBuffer(scheduleBytes) || !/^[a-f0-9]{64}$/u.test(scheduleSHA256 ?? '') || createHash('sha256').update(scheduleBytes).digest('hex') !== scheduleSHA256) throw new Error('405 schedule digest mismatch');
  const schedule = JSON.parse(scheduleBytes.toString('utf8'));
  if (planSHA256 !== ASSIGNED_EFFECTS_PLAN_SHA256 || verifierConcurrency !== 'native' || seed !== '405-dev20-c9ed7a82' ||
      !Array.isArray(caseIds) || caseIds.length !== 20 || new Set(caseIds).size !== 20 || caseIds.some((id) => typeof id !== 'string' || !id) ||
      !schedule || schedule.seed !== seed || schedule.verifierConcurrency !== 'native' || !Array.isArray(schedule.slots) || schedule.slots.length !== 80) throw new Error('invalid 405 registration');
  let firstControlCount = 0;
  const slotIds = new Set();
  for (let i = 0; i < caseIds.length; i++) {
    const chunk = schedule.slots.slice(i * 4, i * 4 + 4);
    const first = chunk[0]?.blind?.arm;
    if (!['control', 'treatment'].includes(first)) throw new Error('405 schedule order mismatch');
    if (first === 'control') firstControlCount++;
    const order = first === 'control' ? ['control', 'treatment'] : ['treatment', 'control'];
    const wanted = [{ arm: order[0], draw: 1 }, { arm: order[1], draw: 1 }, { arm: order[1], draw: 2 }, { arm: order[0], draw: 2 }];
    for (let j = 0; j < 4; j++) {
      const slot = chunk[j], arm = wanted[j].arm;
      if (!slot || slot.caseId !== caseIds[i] || slot.blind?.arm !== arm || slot.blind?.draw !== wanted[j].draw || typeof slot.id !== 'string' || !slot.id || slotIds.has(slot.id) || slot.workerConfig?.assignedEffects !== (arm === 'treatment')) throw new Error('405 schedule order mismatch');
      slotIds.add(slot.id);
    }
  }
  if (firstControlCount !== 10) throw new Error('405 schedule balance mismatch');
  if (schedule.pauseAfterSlot !== schedule.slots[7].id) throw new Error('405 checkpoint mismatch');
  return { slots: 80, cases: 20, checkpointSlots: 8, verifierConcurrency: 'native' };
}

export const ASSIGNED_EFFECTS_SEED = '405-dev20-c9ed7a82';
export const ASSIGNED_EFFECTS_ORDER_RULE = 'Sort case IDs by SHA-256(UTF-8 seed || UTF-8 case ID); draw 1 control first on even ranks and treatment first on odd ranks; reverse within each case on draw 2; emit four contiguous slots per case.';

// A caller must seal this registration before generating the realized order.
export async function seal405Registration({ file, caseIds, oracleManifestSHA256 }) {
  const { constants, closeSync, fsyncSync, openSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { outsideCheckout } = await import('./case.mjs');
  if (typeof file !== 'string' || outsideCheckout(file) !== file || !/^[a-f0-9]{64}$/u.test(oracleManifestSHA256 ?? '') ||
      !Array.isArray(caseIds) || caseIds.length !== 20 || new Set(caseIds).size !== 20 || caseIds.some((id) => typeof id !== 'string' || !id)) throw new Error('invalid 405 registration');
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, planSHA256: ASSIGNED_EFFECTS_PLAN_SHA256, seed: ASSIGNED_EFFECTS_SEED, algorithm: ASSIGNED_EFFECTS_ORDER_RULE,
    verifierConcurrency: 'native', oracleManifestSHA256, caseIds: [...caseIds].sort() })}\n`);
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
      new Set(record.caseIds).size !== 20 || record.caseIds.some((id) => typeof id !== 'string' || !id)) throw new Error('invalid 405 registration');
  const rank = (id) => createHash('sha256').update(record.seed, 'utf8').update(id, 'utf8').digest('hex');
  const caseIds = [...record.caseIds].sort((a, b) => { const x = rank(a), y = rank(b); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; });
  const slots = caseIds.flatMap((caseId, index) => {
    const first = index % 2 === 0 ? 'control' : 'treatment', second = first === 'control' ? 'treatment' : 'control';
    return [{ caseId, arm: first, draw: 1 }, { caseId, arm: second, draw: 1 }, { caseId, arm: second, draw: 2 }, { caseId, arm: first, draw: 2 }];
  });
  return { caseIds, slots, registrationSHA256, seed: record.seed, algorithm: record.algorithm };
}
