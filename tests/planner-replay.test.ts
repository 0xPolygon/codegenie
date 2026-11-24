import { describe, expect, it, vi } from 'vitest';
import { replayPlanner, type PlannerReplay } from '../src/pipeline/planner-replay.js';
import type { TelemetryRecorder } from '../src/telemetry/telemetry-recorder.js';
import type { PlannerDossier } from '../src/types.js';
import { sha256Hex } from '../src/util/hashing.js';
import { stableJson } from '../src/util/json.js';
import { defaultConfig } from '../src/config/schema.js';
import { createFakeRunner } from '../src/llm/fake-runner.js';
import { createGitClient } from '../src/git/git-client.js';
import { runReview } from '../src/pipeline/review-runner.js';
import { commitAll, initRepo, writeRepoFile } from './helpers/git.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dossier = { runId: 'current-run', target: { headSha: 'head', mergeBase: 'base' }, hunkIndex: [{ path: 'a.ts', hunkIds: ['one', 'two'] }] } as unknown as PlannerDossier;
const { runId: _runId, ...stable } = dossier;
const plan = { diffUnderstanding: { declaredIntent: 'intent', inferredBehavior: 'behavior' }, plannerRecovery: { degraded: false },
  coverage: [{ path: 'a.ts', hunkId: 'two', coverage: 'skip', lenses: [], surroundingContextHints: [], reason: 'legacy skip' }] };
const result = { plan, plannerCoverage: { submittedEntries: 1, acceptedEntries: 1, acceptedUniqueHunks: 1, rejectedUnknownHunk: 0 }, degradedPlanning: false, chunked: false };
const capture = JSON.stringify({ result, telemetry: [{ kind: 'event', event: { stage: 5, level: 'info', message: 'stage_started', data: { name: 'planner' } } }, { kind: 'artifact', name: 'review-plan.json', data: plan }] });
function binding(overrides: Partial<PlannerReplay> = {}): PlannerReplay {
  return { capture, captureSHA256: sha256Hex(capture), diffSHA256: sha256Hex('diff'), expectedDossierSHA256: sha256Hex(stableJson(stable)),
    baseSHA: 'base', headSHA: 'head', hunks: [{ path: 'a.ts', hunkId: 'one' }, { path: 'a.ts', hunkId: 'two' }], ...overrides };
}
function telemetry() {
  return { event: vi.fn(), writeArtifact: vi.fn(async () => undefined) } as unknown as TelemetryRecorder;
}

describe('planner replay', () => {
  it('replays through the real review pipeline and refuses drift before a model call', async () => {
    const repo = initRepo(), root = mkdtempSync(path.join(tmpdir(), 'planner-replay-pipeline-'));
    try {
      writeRepoFile(repo, 'app.ts', 'export const value = 1;\n'); const base = commitAll(repo, 'base');
      writeRepoFile(repo, 'app.ts', 'export const value = 2; // CODEGENIE_FAKE_FINDING\n'); const head = commitAll(repo, 'change');
      const cfg = { ...defaultConfig, lenses: { enabled: ['core/code-review'], disabled: [], extraSkillPaths: [] },
        telemetry: { ...defaultConfig.telemetry, enabled: false }, llm: { provider: 'fake', model: 'fake-model', maxConcurrentCalls: 1 } };
      const firstDir = path.join(root, 'first');
      await runReview({ mode: 'head', baseRef: base, headRef: head }, cfg, { repoRoot: repo, runArtifactDir: firstDir, runner: createFakeRunner() });
      const actualDossier = JSON.parse(readFileSync(path.join(firstDir, 'stages/05-planner/planner-dossier.json'), 'utf8')) as PlannerDossier;
      const actualPlan = JSON.parse(readFileSync(path.join(firstDir, 'stages/05-planner/review-plan.json'), 'utf8'));
      const { runId: _ignored, ...stableDossier } = actualDossier;
      const captured = JSON.stringify({ result: { plan: actualPlan, plannerCoverage: { submittedEntries: 0, acceptedEntries: 0, acceptedUniqueHunks: 0, rejectedUnknownHunk: 0 }, degradedPlanning: false, chunked: false },
        telemetry: [{ kind: 'artifact', name: 'review-plan.json', data: actualPlan }] });
      const replay = { capture: captured, captureSHA256: sha256Hex(captured), diffSHA256: sha256Hex(await createGitClient(repo).diff(base, head)),
        expectedDossierSHA256: sha256Hex(stableJson(stableDossier)), baseSHA: base, headSHA: head,
        hunks: actualDossier.hunkIndex.flatMap((entry) => entry.hunkIds.map((hunkId) => ({ path: entry.path, hunkId }))) };
      const fake = createFakeRunner(), stages: number[] = [], secondDir = path.join(root, 'second');
      await runReview({ mode: 'head', baseRef: base, headRef: head }, cfg, { repoRoot: repo, runArtifactDir: secondDir, plannerReplay: replay,
        runner: { runStructured: async <T>(request: Parameters<typeof fake.runStructured<T>>[0]) => { stages.push(request.stage); return fake.runStructured(request); } } });
      expect(stages).not.toContain(5); expect(stages).toContain(7);
      expect(readdirSync(path.join(secondDir, 'stages/06-packets/packets')).sort()).toEqual(readdirSync(path.join(firstDir, 'stages/06-packets/packets')).sort());
      const calls = vi.fn();
      await expect(runReview({ mode: 'head', baseRef: base, headRef: head }, cfg, { repoRoot: repo, runArtifactDir: path.join(root, 'bad'), plannerReplay: { ...replay, diffSHA256: '0'.repeat(64) },
        runner: { runStructured: calls } })).rejects.toMatchObject({ code: 'config_error', context: { reason: 'binding_mismatch' } });
      expect(calls).not.toHaveBeenCalled();
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
  it('preserves the captured plan and omissions while marking only events as replayed', async () => {
    const sink = telemetry();
    expect(await replayPlanner(binding(), dossier, 'diff', sink)).toEqual(result);
    expect(sink.writeArtifact).toHaveBeenCalledWith('review-plan.json', plan);
    expect(sink.event).toHaveBeenCalledWith(expect.objectContaining({ message: 'stage_started', data: { name: 'planner', replayed: true } }));
    expect(sink.event).toHaveBeenCalledWith(expect.objectContaining({ message: 'planner_replayed', data: { captureSHA256: sha256Hex(capture), replayed: true } }));
  });
  it.each([
    { capture: `${capture} ` }, { diffSHA256: '0'.repeat(64) }, { expectedDossierSHA256: '0'.repeat(64) },
    { headSHA: 'other' }, { baseSHA: 'other' }, { hunks: [{ path: 'a.ts', hunkId: 'two' }, { path: 'a.ts', hunkId: 'one' }] }
  ])('refuses a mismatched binding before replaying telemetry', async (change) => {
    const sink = telemetry();
    await expect(replayPlanner(binding(change), dossier, 'diff', sink)).rejects.toMatchObject({ code: 'config_error', context: { reason: 'binding_mismatch' } });
    expect(sink.event).not.toHaveBeenCalled(); expect(sink.writeArtifact).not.toHaveBeenCalled();
  });
  it('refuses a coverage decision or embedded dossier digest that does not match', async () => {
    for (const change of [
      { result: { ...result, plan: { ...plan, coverage: [{ ...plan.coverage[0], path: 'wrong.ts' }] } }, telemetry: [] },
      { result, telemetry: [{ kind: 'artifact', name: 'review-plan.json', data: plan }], dossierDigest: '0'.repeat(64) }
    ]) {
      const text = JSON.stringify(change), sink = telemetry();
      await expect(replayPlanner(binding({ capture: text, captureSHA256: sha256Hex(text) }), dossier, 'diff', sink)).rejects.toMatchObject({ context: { reason: 'binding_mismatch' } });
      expect(sink.event).not.toHaveBeenCalled(); expect(sink.writeArtifact).not.toHaveBeenCalled();
    }
  });
  it('does not turn a telemetry write failure into a binding mismatch', async () => {
    const sink = telemetry(); vi.mocked(sink.writeArtifact).mockRejectedValue(new Error('synthetic write failure'));
    await expect(replayPlanner(binding(), dossier, 'diff', sink)).rejects.toThrow('synthetic write failure');
  });
});
