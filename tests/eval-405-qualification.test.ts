import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { ASSIGNED_EFFECTS_PLAN_SHA256, validate405Schedule } from '../evals/runner/qualification-405.mjs';

it('checks all 80 frozen slots, the paired order, seed and first-two-case pause', () => {
  const caseIds = Array.from({ length: 20 }, (_, index) => `case-${index + 1}`), seed = '405-dev20-c9ed7a82';
  const rank = (id: string) => createHash('sha256').update(JSON.stringify([seed, id])).digest('hex');
  const first = new Set([...caseIds].sort((a, b) => rank(a) < rank(b) ? -1 : 1).slice(0, 10));
  const slots = caseIds.flatMap((caseId) => {
    const [a, b] = first.has(caseId) ? ['control', 'treatment'] : ['treatment', 'control'];
    return [[a, 1], [b, 1], [b, 2], [a, 2]].map(([arm, draw]) => ({ id: `${caseId}-${arm}-${draw}`, caseId, blind: { arm, draw }, workerConfig: { assignedEffects: arm === 'treatment' } }));
  });
  const schedule = { slots, seed, verifierConcurrency: 'native', pauseAfterSlot: slots[7]!.id };
  const bound = (value: unknown) => { const scheduleBytes = Buffer.from(JSON.stringify(value)); return { scheduleBytes, scheduleSHA256: createHash('sha256').update(scheduleBytes).digest('hex') }; };
  const config = { ...bound(schedule), caseIds, seed, planSHA256: ASSIGNED_EFFECTS_PLAN_SHA256, verifierConcurrency: 'native' };
  expect(validate405Schedule(config)).toMatchObject({ slots: 80, checkpointSlots: 8 });
  const altered = structuredClone(schedule); [altered.slots[78], altered.slots[79]] = [altered.slots[79]!, altered.slots[78]!];
  expect(() => validate405Schedule({ ...config, ...bound(altered) })).toThrow('order');
  expect(() => validate405Schedule({ ...config, ...bound({ ...schedule, pauseAfterSlot: slots[8]!.id }) })).toThrow('checkpoint');
  expect(() => validate405Schedule({ ...config, seed: 'other' })).toThrow('registration');
  expect(() => validate405Schedule({ ...config, verifierConcurrency: '1' })).toThrow('registration');
  expect(() => validate405Schedule({ ...config, scheduleBytes: bound(altered).scheduleBytes })).toThrow('digest');
  const swappedBlocks = structuredClone(schedule); const block = swappedBlocks.slots.splice(72, 4); swappedBlocks.slots.splice(68, 0, ...block);
  const reorderedCases = [...caseIds]; [reorderedCases[17], reorderedCases[18]] = [reorderedCases[18]!, reorderedCases[17]!];
  expect(validate405Schedule({ ...config, ...bound(swappedBlocks), caseIds: reorderedCases })).toMatchObject({ slots: 80 });
  expect(() => validate405Schedule({ ...config, scheduleBytes: bound(swappedBlocks).scheduleBytes, caseIds: reorderedCases })).toThrow('digest');
});

it('seals the registered seed and algorithm before deterministic order generation', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // @ts-expect-error Development-only ESM has no emitted types.
  const { seal405Registration, generate405Order, ASSIGNED_EFFECTS_SEED } = await import('../evals/runner/qualification-405.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'eval-405-order-'));
  try {
    const file = join(dir, 'registration.json'), caseIds = Array.from({ length: 20 }, (_, index) => `case-${index + 1}`);
    const registrationSHA256 = await seal405Registration({ file, caseIds, oracleManifestSHA256: 'a'.repeat(64) });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ seed: ASSIGNED_EFFECTS_SEED, verifierConcurrency: 'native' });
    const result = await generate405Order({ registrationFile: file, registrationSHA256 });
    expect(result.slots).toHaveLength(80); expect(result.slots[0].arm).toBe('control'); expect(result.slots[4].arm).toBe('treatment');
    expect(await generate405Order({ registrationFile: file, registrationSHA256 })).toEqual(result);
    await expect(generate405Order({ registrationFile: file, registrationSHA256: 'f'.repeat(64) })).rejects.toThrow('changed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
