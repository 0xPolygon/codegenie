import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config/schema.js';
import { resolveEvalCaseConfig } from '../src/evals/eval-runner.js';
import type { EvalCase } from '../src/types.js';
// @ts-expect-error Development-only ESM has no emitted types.
import { assertExpectedCalls, deriveExpectedCalls } from '../evals/runner/expected-calls.mjs';

describe('effective campaign calls', () => {
  it('derives each stage from the resolved case layer and dynamic effort policy', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-stage-binding-'));
    try {
      const base = structuredClone(defaultConfig);
      base.llm.provider = 'openrouter'; base.llm.model = 'openai/gpt-6-luna'; base.llm.reasoning = 'high';
      const control = resolveEvalCaseConfig(base, {} as EvalCase, dir, false).config;
      const treatment = resolveEvalCaseConfig(base, { llm: { stages: { review: { model: 'openrouter/openai/gpt-6.1-terra', reasoning: 'high' } } } } as EvalCase, dir, false).config;
      const templates = { 5: 'p5.9', 7: 'p7.16', 9: 'p9.31', 10: 'p10.25' };
      const a = deriveExpectedCalls(control, templates), b = deriveExpectedCalls(treatment, templates);
      expect(() => assertExpectedCalls(treatment, b)).not.toThrow();
      expect(() => assertExpectedCalls(treatment, a)).toThrow('effective expected calls mismatch');
      expect(b.filter((x: { stage: number }) => x.stage !== 7)).toEqual(a.filter((x: { stage: number }) => x.stage !== 7));
      expect(b.filter((x: { stage: number }) => x.stage === 7).every((x: { modelId: string }) => x.modelId === 'openai/gpt-6.1-terra')).toBe(true);
      expect(b.find((x: { stage: number; kind: string; purpose?: string }) => x.stage === 7 && x.kind === 'repair' && !x.purpose).reasoningSelected).toBe('low');
      expect(b.find((x: { stage: number; kind: string }) => x.stage === 10 && x.kind === 'initial').reasoningSelected).toBe('medium');
      const explicitCompose = structuredClone(treatment);
      explicitCompose.llm.stages = { ...explicitCompose.llm.stages, compose: { reasoning: 'high' } };
      expect(deriveExpectedCalls(explicitCompose, templates).find((x: { stage: number; kind: string }) => x.stage === 10 && x.kind === 'initial').reasoningSelected).toBe('high');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
