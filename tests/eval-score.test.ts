import { describe, expect, it } from 'vitest';
// @ts-expect-error Development runner has no TypeScript declarations.
import { gatePasses, scoreCampaign } from '../evals/runner/score.mjs';

const receipt = 'a'.repeat(64);
function fixture(): any {
  const schedule = [{ slotId: 'slot-01', caseId: 'case-01', arm: 'treatment', draw: 1 }];
  const inventory = [{ caseId: 'case-01', role: 'negative-control', causes: [{ id: 'optional', optional: true }], rejects: [] }];
  const dispositions = [{ ...schedule[0], state: 'selected', bundleIndex: 0, attempt: 1, receiptSHA256: receipt }];
  const grade = { id: 'sheet', causes: [{ causeId: 'optional', publication: 'finding', publishedId: 'p' }], assertions: [{ publishedId: 'p', status: 'unresolved', missingEvidence: 'source missing' }], otherClaims: { published: [], survivingMediumPlus: [] } };
  const bundles = [{ manifest: { sheets: [{ id: 'sheet', case: 'case-01', role: 'negative-control', causes: inventory[0]!.causes, rejects: [] }] }, mapping: { selections: [{ ...schedule[0], id: 'sheet', attempt: 1, receiptSHA256: receipt }] }, reconciliation: { grades: [grade] }, reveal: { reviews: [{ id: 'sheet', case: 'case-01', arm: 'treatment', draw: 1 }] }, sheets: [{ id: 'sheet', case: 'case-01', verification: [], published: { findings: [{ id: 'p', severity: 'medium' }], summaryOnly: [] } }] }];
  return { schedule, inventory, dispositions, bundles };
}
describe('clean-control.v2 scoring', () => {
  it('counts linked unresolved assertions in the upper bound without losing optional credit', () => {
    const args = fixture(), result = scoreCampaign(args);
    expect(result.arms.treatment).toMatchObject({ E1: { published: 0, required: 0 }, E2: { lower: 0, upper: 1, reviews: 1 }, E3: { lower: 0, upper: 1 }, optionalPublished: 1 });
    expect(result.perDraw).toMatchObject({ '1': { treatment: { E2: { lower: 0, upper: 1 } } } });
    expect(Array.isArray(result.perDraw)).toBe(false);
    expect(gatePasses({ upper: 1 }, { lower: 1 })).toBe(true);
    expect(gatePasses({ upper: 1 }, { lower: 0 })).toBe(false);
    expect(JSON.stringify(scoreCampaign(args))).toBe(JSON.stringify(result));
  });
  it('refuses a substituted receipt and a duplicated graded slot', () => {
    const args = fixture(); args.bundles[0].mapping.selections[0].receiptSHA256 = 'b'.repeat(64);
    expect(() => scoreCampaign(args)).toThrow('receipt');
    const again = fixture(); expect(() => scoreCampaign({ ...again, bundles: [again.bundles[0], again.bundles[0]] })).toThrow();
  });
  it('deduplicates a false assertion that hits two sentinels while retaining cause credit', () => {
    const args = fixture();
    args.bundles[0].reconciliation.grades[0].assertions[0] = { publishedId: 'p', status: 'refuted', missingEvidence: 'unused' };
    const g = args.bundles[0].reconciliation.grades[0] as { rejects?: unknown[] };
    g.rejects = [{ rejectId: 'r1', publishedIds: ['p'] }, { rejectId: 'r2', publishedIds: ['p'] }];
    args.inventory[0].rejects = ['r1', 'r2'] as never[];
    args.bundles[0].manifest.sheets[0].rejects = [{ id: 'r1' }, { id: 'r2' }] as never[];
    const result = scoreCampaign(args);
    expect(result.arms.treatment).toMatchObject({ E2: { lower: 1, upper: 1 }, E3: { lower: 1, upper: 1 }, optionalPublished: 1, sentinelHits: 2 });
  });
  it('counts two false published IDs against one reject as two claims and one review', () => {
    const args = fixture(), grade = args.bundles[0].reconciliation.grades[0];
    grade.assertions = [{ publishedId: 'p', status: 'refuted', evidence: 'source' }];
    grade.otherClaims.published = [{ id: 'q', class: 'wholly_false', slug: 'false', severity: 'medium', summaryOnly: false }];
    grade.rejects = [{ rejectId: 'r1', publishedIds: ['p', 'q'] }];
    args.bundles[0].sheets[0].published.findings.push({ id: 'q', severity: 'medium' });
    args.inventory[0].rejects = ['r1']; args.bundles[0].manifest.sheets[0].rejects = [{ id: 'r1' }];
    expect(scoreCampaign(args).arms.treatment).toMatchObject({ E2: { lower: 1, upper: 1 }, E3: { lower: 2, upper: 2 }, optionalPublished: 1, sentinelHits: 1 });
  });
  it('scores a failed positive as zero and an unrun positive as incomplete', () => {
    const args = fixture(); args.inventory[0] = { ...args.inventory[0], role: 'positive', causes: [{ id: 'first', optional: false }, { id: 'second', optional: false }] };
    const failed = scoreCampaign({ ...args, bundles: [], dispositions: [{ ...args.dispositions[0], state: 'failed' }] });
    expect(failed).toMatchObject({ complete: true, arms: { treatment: { E1: { published: 0, required: 2 } } } });
    const unrun = scoreCampaign({ ...args, bundles: [], dispositions: [{ ...args.dispositions[0], state: 'unrun' }] });
    expect(unrun).toMatchObject({ complete: false, arms: { treatment: { E1: { published: 0, required: 0 } } } });
  });
  it('joins a fresh attempt from a second bundle once without scoring an earlier void', () => {
    const first = fixture(), second = fixture();
    second.schedule[0].slotId = 'slot-02'; second.schedule[0].draw = 2;
    Object.assign(second.dispositions[0], { slotId: 'slot-02', draw: 2, attempt: 2, bundleIndex: 1, receiptSHA256: 'd'.repeat(64) });
    Object.assign(second.bundles[0].mapping.selections[0], { slotId: 'slot-02', draw: 2, attempt: 2, receiptSHA256: 'd'.repeat(64), id: 'sheet-2' });
    second.bundles[0].manifest.sheets[0].id = 'sheet-2'; second.bundles[0].reconciliation.grades[0].id = 'sheet-2';
    second.bundles[0].reveal.reviews[0].id = 'sheet-2'; second.bundles[0].reveal.reviews[0].draw = 2; second.bundles[0].sheets[0].id = 'sheet-2';
    const input = { schedule: [...first.schedule, ...second.schedule], inventory: first.inventory, dispositions: [...first.dispositions, ...second.dispositions], bundles: [...first.bundles, ...second.bundles] };
    expect(scoreCampaign(input)).toMatchObject({ complete: true, arms: { treatment: { E2: { reviews: 2 } } } });
    second.bundles[0].mapping.selections[0].receiptSHA256 = receipt;
    expect(() => scoreCampaign(input)).toThrow('receipt');
  });
});

it('marks historical fallback roles ambiguous and absent assertion annotations unmeasured', async () => {
  // @ts-expect-error Development runner has no TypeScript declarations.
  const { scoreHistorical } = await import('../evals/runner/score-historical.mjs');
  const args = fixture(); delete (args.inventory[0] as { role?: string }).role;
  delete (args.bundles[0].manifest.sheets[0] as { role?: string }).role;
  delete (args.bundles[0].reconciliation.grades[0] as { assertions?: unknown }).assertions;
  args.bundles[0].reconciliation.lockSHA256 = ['a'.repeat(64), 'b'.repeat(64)];
  const out = scoreHistorical({ ...args, componentHashes: ['c'.repeat(64)] });
  expect(out).toMatchObject({ source: 'historical-adapter', roleAmbiguous: true, mixedAssertions: 'unmeasured-class-only' });
});

it('retains unavailable historical studies without inventing scores', async () => {
  // @ts-expect-error Development runner has no TypeScript declarations.
  const { scoreHistoricalStudies } = await import('../evals/runner/score-historical.mjs');
  const args = fixture();
  const empty = { ...args, bundles: [], dispositions: [{ ...args.dispositions[0], state: 'failed' }], componentHashes: ['c'.repeat(64)] };
  const invalid = { ...args, componentHashes: ['c'.repeat(64)] }; // Missing the two verified lock digests.
  const report = scoreHistoricalStudies([{ studyId: 'missing', ...empty }, { studyId: 'incompatible', ...invalid }, { studyId: 'offline', unavailable: { reason: 'locks not retained' } }]);
  expect(report.studies).toEqual([
    { studyId: 'missing', status: 'unavailable', reason: 'historical evidence missing or incompatible' },
    { studyId: 'incompatible', status: 'unavailable', reason: 'historical evidence missing or incompatible' },
    { studyId: 'offline', status: 'unavailable', reason: 'locks not retained' }
  ]);
  expect(report.studies.every((study: Record<string, unknown>) => !('result' in study) && !('arms' in study))).toBe(true);
  args.bundles[0].reconciliation.lockSHA256 = ['a'.repeat(64), 'b'.repeat(64)];
  const scored = scoreHistoricalStudies([{ studyId: 'verified', ...args, componentHashes: ['c'.repeat(64)] }]);
  expect(scored.studies[0]).toMatchObject({ studyId: 'verified', status: 'scored', result: { complete: true } });
});
