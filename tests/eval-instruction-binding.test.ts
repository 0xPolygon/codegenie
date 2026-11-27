import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Development-only ESM has no emitted types.
import { assertInstructionBinding, validateInstructionArms } from '../evals/runner/instruction-binding.mjs';
// @ts-expect-error Development-only ESM has no emitted types.
import { assertIntegrity, buildDigest, treeDigest } from '../evals/runner/integrity.mjs';

const calls = (version: string) => [5, 7, 9, 10].map((stage) => ({ stage, kind: 'initial', provider: 'openrouter', modelId: 'openai/gpt-6-luna', reasoningSelected: stage === 10 ? 'medium' : 'high', wireEffort: stage === 10 ? 'medium' : 'high', templateVersion: stage === 9 ? version : stage === 7 ? version === 'p9.32' ? 'p7.18' : 'p7.16' : 'fixture' }));
const config = (instructionSet: string) => ({ llm: { provider: 'openrouter', model: 'openai/gpt-6-luna', reasoning: 'high' }, review: { stage7Instructions: instructionSet } });

it('binds instructions and the shared global-high policy to the effective arm', () => {
  expect(validateInstructionArms({ instructionSets: { control: 'v1', treatment: 'v2' }, effortPolicy: 'global-high' })).toEqual({ control: 'v1', treatment: 'v2' });
  expect(validateInstructionArms(undefined)).toBeUndefined();
  expect(() => validateInstructionArms({ instructionSets: { control: 'v2', treatment: 'v1' }, effortPolicy: 'global-high' })).toThrow();
  const control = assertInstructionBinding(config('v1'), calls('p9.31'), 'v1');
  expect(assertInstructionBinding(config('v2'), calls('p9.32'), 'v2')).toBe(control);
  expect(() => assertInstructionBinding(config('v2'), calls('p9.32'), 'v1')).toThrow('arm mismatch');
  expect(() => assertInstructionBinding({ ...config('v1'), llm: { ...config('v1').llm, reasoning: 'low' } }, calls('p9.31'), 'v1')).toThrow('effort policy');
  expect(() => assertInstructionBinding({ ...config('v1'), llm: { ...config('v1').llm, stages: { review: { reasoning: 'high' } } } }, calls('p9.31'), 'v1')).toThrow('effort policy');
  expect(() => assertInstructionBinding(config('v2'), calls('p9.31'), 'v2')).toThrow('verifier template');
  const wrongPacket = calls('p9.32'); wrongPacket[1]!.templateVersion = 'p7.16';
  expect(() => assertInstructionBinding(config('v2'), wrongPacket, 'v2')).toThrow('packet template');
  const changed = calls('p9.32'); changed[1]!.reasoningSelected = 'low';
  expect(assertInstructionBinding(config('v2'), changed, 'v2')).not.toBe(control);
});

it('binds every byte of the v2 skill inventory to the build', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-integrity-'));
  try {
    const copy = path.join(dir, 'skills'); cpSync(path.join(process.cwd(), 'bundled-skills-v2'), copy, { recursive: true });
    const digest = buildDigest(), original = treeDigest(copy); expect(digest.skillsV2).toBe(original);
    const findFile = (root: string): string => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const name = path.join(root, entry.name);
        if (entry.isFile()) return name;
        if (entry.isDirectory()) { const found = findFile(name); if (found) return found; }
      }
      return '';
    };
    const file = findFile(copy); expect(file).not.toBe(''); writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('x')]));
    expect(treeDigest(copy)).not.toBe(original);
    expect(() => assertIntegrity({ suiteDir: copy, suiteSHA256: treeDigest(copy), build: { ...digest, skillsV2: treeDigest(copy) } })).toThrow('input binding mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
