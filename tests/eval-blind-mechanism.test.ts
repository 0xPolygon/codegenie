import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { projectMechanism } from '../evals/runner/blind-mechanism.mjs';

it('retains incomplete treatment passes and uncovered hunks without inventing effects', () => {
  const packets = [{ id: 'packet', path: 'src/a.ts', hunks: [{ hunkId: 'one', lines: [{ content: 'before' }] }, { hunkId: 'two', lines: [{ content: 'after' }] }] }];
  const record = { packetId: 'packet', pass: 1, assignedHunkIds: ['one', 'two'], reviewStatus: 'incomplete', assignedEffects: [] };
  const result = projectMechanism({ id: 'a'.repeat(24), packets, records: [record] });
  expect(result.passes[0]).toMatchObject({ uncoveredHunks: ['one', 'two'], effects: [], source: { path: 'src/a.ts' } });
  expect(() => projectMechanism({ id: 'a'.repeat(24), packets, records: [{ ...record, reviewStatus: 'no_findings' }] })).toThrow('coverage');
  expect(() => projectMechanism({ id: 'a'.repeat(24), packets, records: undefined })).toThrow();
  expect(() => projectMechanism({ id: 'a'.repeat(24), packets, records: [{ ...record, assignedEffects: [{ hunkId: 'other', effect: 'x', kind: 'none', disposition: 'safe', basis: 'x' }] }] })).toThrow('effect row');
});
