import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { ASSIGNED_EFFECTS_PLAN_SHA256, validate405Schedule } from '../evals/runner/qualification-405.mjs';

it('checks all 80 frozen slots, the paired order, seed and first-two-case pause', () => {
  const caseIds = Array.from({ length: 20 }, (_, index) => `case-${index + 1}`), seed = '405-dev20-c9ed7a82';
  const rank = (id: string) => createHash('sha256').update(seed).update(id).digest('hex');
  const order = [...caseIds].sort((a, b) => rank(a) < rank(b) ? -1 : 1);
  const slots = order.flatMap((caseId, index) => {
    const [a, b] = index % 2 === 0 ? ['control', 'treatment'] : ['treatment', 'control'];
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
  expect(() => validate405Schedule({ ...config, ...bound(swappedBlocks), caseIds: reorderedCases })).toThrow('order');
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
    const { writeFileSync } = await import('node:fs');
    const oracleManifestPath = join(dir, 'oracle.json'), oracleBytes = Buffer.from(JSON.stringify({ cases: caseIds.map((caseId) => ({ caseId, causes: [] })) })); writeFileSync(oracleManifestPath, oracleBytes);
    const diffPath = join(dir, 'diff.patch'), diffBytes = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n'); writeFileSync(diffPath, diffBytes);
    const diffSources = caseIds.map((caseId) => ({ caseId, path: diffPath, sha256: createHash('sha256').update(diffBytes).digest('hex') }));
    const registrationSHA256 = await seal405Registration({ file, caseIds, oracleManifestPath, oracleManifestSHA256: createHash('sha256').update(oracleBytes).digest('hex'), diffSources });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ seed: ASSIGNED_EFFECTS_SEED, verifierConcurrency: 'native' });
    const result = await generate405Order({ registrationFile: file, registrationSHA256 });
    expect(result.slots).toHaveLength(80); expect(result.slots[0].arm).toBe('control'); expect(result.slots[4].arm).toBe('treatment');
    expect(await generate405Order({ registrationFile: file, registrationSHA256 })).toEqual(result);
    const altered = JSON.parse(readFileSync(file, 'utf8')); altered.cases[0].causes.push({ id: 'manual', optional: false, hunkIds: [], unmapped: true });
    const alteredFile = join(dir, 'altered.json'), alteredBytes = Buffer.from(JSON.stringify(altered)); writeFileSync(alteredFile, alteredBytes);
    await expect(generate405Order({ registrationFile: alteredFile, registrationSHA256: createHash('sha256').update(alteredBytes).digest('hex') })).rejects.toThrow('anchor mapping changed');
    await expect(generate405Order({ registrationFile: file, registrationSHA256: 'f'.repeat(64) })).rejects.toThrow('changed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('freezes anchor overlap mechanically, keeping unmapped causes distinct', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // @ts-expect-error Development-only ESM has no emitted types.
  const { derive405AnchorMappings } = await import('../evals/runner/qualification-405.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'eval-405-anchors-'));
  try {
    const caseIds = Array.from({ length: 20 }, (_, index) => `case-${index + 1}`), oracleManifestPath = join(dir, 'oracle.json');
    const cases = caseIds.map((caseId, index) => ({ caseId, causes: index === 0 ? [
      { id: 'mapped', optional: false, anchors: [{ path: 'a', lineRange: [1, 1] }] },
      { id: 'unmapped', optional: true, anchors: [{ path: 'other', lineRange: [1, 1] }] }
    ] : index === 1 ? [{ id: 'deleted', optional: false, anchors: [{ path: 'gone', lineRange: [5, 5] }] }] : [] }));
    const oracle = Buffer.from(JSON.stringify({ cases })); writeFileSync(oracleManifestPath, oracle);
    const diff = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n'), diffPath = join(dir, 'diff.patch'); writeFileSync(diffPath, diff);
    const deletedPath = join(dir, 'deleted.patch'), deleted = Buffer.from('diff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -5 +0,0 @@\n-old\n'); writeFileSync(deletedPath, deleted);
    const mapping = await derive405AnchorMappings({ oracleManifestPath, oracleManifestSHA256: createHash('sha256').update(oracle).digest('hex'),
      diffSources: caseIds.map((caseId, index) => ({ caseId, path: index === 1 ? deletedPath : diffPath, sha256: createHash('sha256').update(index === 1 ? deleted : diff).digest('hex') })) });
    const first = mapping.find((item: { caseId: string }) => item.caseId === caseIds[0]);
    expect(first.causes[0].unmapped).toBe(false); expect(first.causes[0].hunkIds).toHaveLength(1);
    expect(first.causes[1]).toMatchObject({ unmapped: true, hunkIds: [] });
    const deletedCase = mapping.find((item: { caseId: string }) => item.caseId === caseIds[1]);
    expect(deletedCase.causes[0].unmapped).toBe(false); expect(deletedCase.causes[0].hunkIds).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
