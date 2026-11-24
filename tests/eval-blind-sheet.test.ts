import { describe, expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { projectBlindSheet } from '../evals/runner/blind-sheet.mjs';

describe('blind grading projection', () => {
  it('preserves discovery, related-question joins and visible output without treatment identifiers', () => {
    const input = { id: 'a'.repeat(24), caseId: 'example', outcome: 'completed_partial', key: Buffer.alloc(32, 7),
      candidates: [{ id: 'candidate-001', path: 'src/a.ts', title: 'A test can pass when the write fails', failureMode: 'search_files found a missing guard', evidence: { changedCode: 'write()' } },
        { id: 'candidate-002', path: 'src/a.ts', title: 'Related', provenance: { source: 'uncertainty_promotion' } }],
      promotion: { decisions: [{ packetId: 'packet-secret', sourceKind: 'uncertainty', question: 'Could the test pass?', files: ['src/a.ts'], promoted: false, reason: 'represented_as_related_signal', candidateId: 'candidate-002' },
        { packetId: 'packet-secret', sourceKind: 'follow_up_hint', question: 'What happens next?', files: [], promoted: false, reason: 'no_concrete_file_or_symbol' }] },
      verification: [{ candidateId: 'candidate-002', gate: 'verified', verdict: { verdict: 'reject', reason: 'insufficient proof' } }],
      finalReview: { findings: [{ id: 'finding-001', path: 'src/a.ts', mergedCandidateIds: ['candidate-001'], finalBody: 'Visible text\n```ts\nsecret code\n```\n<details>hidden</details>' }],
        summaryOnlyFindings: [{ id: 'finding-002', path: 'src/a.ts', finalBody: 'Summary' }], needsHumanAttention: [{ question: 'Inspect this?', files: ['src/a.ts'] }], assignedEffects: ['do not export'], score: 'fail' } };
    const result = projectBlindSheet(input), text = JSON.stringify(result);
    expect(result.reviewComplete).toBe(false);
    expect(result.discovery.findings).toHaveLength(1);
    expect(result.discovery.findings[0].title).toContain('pass when the write fails');
    expect(result.discovery.questions).toHaveLength(2);
    expect(result.discovery.questions[0].candidateId).toBe(result.verification[0].candidateId);
    expect(result.discovery.questions[1].dropReason).toBe('no_concrete_file_or_symbol');
    expect(result.published.findings[0].mergedCandidateIds[0]).toBe(result.discovery.findings[0].id);
    expect(result.published.findings[0].visibleBody).toContain('[code block]');
    expect(result.published.summaryOnly).toHaveLength(1);
    expect(text).not.toMatch(/candidate-00|packet-secret|finding-00|search_files|secret code|hidden|"score"/u);
    try { projectBlindSheet({ ...input, candidates: [{ id: 'candidate-001', failureMode: 'assignedEffects skipped_path' }], verification: [] }); throw new Error('expected refusal'); } catch (error) { expect(error).toMatchObject({ hits: 2, affectedSheets: 1 }); }
    expect(projectBlindSheet({ ...input, id: 'b'.repeat(24) }).discovery.findings[0].id).not.toBe(result.discovery.findings[0].id);
  });
  it('refuses malformed or absolute source locators', () => {
    expect(() => projectBlindSheet({ id: 'a'.repeat(24), caseId: 'x', outcome: 'completed_full', key: Buffer.alloc(32), candidates: [{ id: 'candidate-1', path: '/private/file' }], promotion: { decisions: [] }, verification: [], finalReview: {} })).toThrow('source locator');
  });
});
