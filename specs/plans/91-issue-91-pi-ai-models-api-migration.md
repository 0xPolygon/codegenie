# Issue 91: pi-ai Models-API Migration (off the `/compat` Entrypoint)

Status: COMPLETE
Closed 2026-07-03. Validation protocol satisfied: (1) 613/613 tests + typecheck + build green with protocol-contract tests unchanged; (2) A/B protocol-posture diff = eval run `0c4d5213/50` on the migrated transport vs runs 32/49 pre-migration — `provider_protocol` field-identical (forced:submit_plan effective, no downgrade, adaptive-effort, worker session keys), zero `tool_choice_downgraded` events, ttfb/rateLimit capture intact; (3) provider CLI smoke on migrated code: `auth-status` reads stored api_key, model catalog lists; (4) debugTrace spot-check on run 50: runner request records forced `toolChoice {type:"tool", name:"submit_plan"}`, same shape as pre-migration. Auth = Option A (codegenie-owned resolution, per-call apiKey injection; `models.getAuth()` intentionally unused — pi's credential-store resolver order differs). Manifest at `^0.80.3`; future pi upgrades go through normal review, no compat surface left to re-roll.
Implementation status (2026-07-03): Option A selected for auth reconciliation. Runtime calls keep codegenie's env → stored api_key → stored OAuth-with-refresh resolution and inject the resolved apiKey per call; pi-ai `models.getAuth()` is intentionally unused because pi's credential-store resolver treats stored credentials as owning the provider and only falls back to env when no credential is stored. The code migration is implemented off `/compat`; the owner A/B protocol-posture diff remains the release gate before running this in a measurement campaign.
Planned from: the pi-ai 0.80.3 upgrade (2026-07-02): the legacy global API surface codegenie uses moved to a `@earendil-works/pi-ai/compat` entrypoint that upstream documents as temporary — "verbatim behavior, one import-path change… It will be removed in a future release; migrate to `createModels()` + provider factories." Adopted commit `07edebc`; punchlisted same day.
Planned at: commit `46872b9` (branch `next`)
Recommended priority: medium — no forcing function while pi-ai is pinned to 0.80.x, but the pin blocks future pi upgrades (each unpinned upgrade re-rolls the compat surface). Land in a quiet window between measurement campaigns; NEVER mid-campaign — this is transport-seam surgery and every A/B depends on the transport being constant.

## Problem

codegenie's LLM transport imports pi-ai's old global API from `/compat`:

- `src/llm/pi-runner.ts`: `complete`, `completeSimple`, `getEnvApiKey`, `getModel`, `getModels`, `getProviders`, `validateToolCall` (+ types `Api`, `Context`, `Model`, `KnownProvider`, `SimpleStreamOptions`, `Tool`, `ToolCall`) and `@earendil-works/pi-ai/oauth` helpers (`getOAuthApiKey`, `getOAuthProvider`) for stored-OAuth refresh.
- `src/provider/provider-services.ts`: `getEnvApiKey`, `getModels`, `getProviders` for the provider CLI (`login`, `auth-status`, model listing) plus codegenie's own `createFileAuthStorage` (a `PiAuthStorage` over `auth.json`).
- `tests/phase4-llm.test.ts`: `complete`/`completeSimple` types for adapter-injection fakes; oauth helper mocks.

The new surface replaces the global registry with a `createModels()` instance (`models.getModel/getModels/getProviders/stream/getAuth`), provider factories (`createProvider` + `models.setProvider`), a credential-store contract for auth, and `fauxProvider()` for tests. Compat is a strict superset re-export today, so behavior is identical — but it has a scheduled death, and the migration is architecture, not renames: auth resolution order, client construction, header assembly, and retry behavior all live on this seam. Plan 86 exists because silent protocol differences on this seam burned us; the migration must be held to the same standard.

## What must be preserved (the protocol contract)

The migration is correct iff every one of these is byte-equivalent before/after, per provider:

1. **Tool-choice dialects** — `mapProviderToolChoice` per API family, including plan 86 step 3's Anthropic forced-submit (thinking explicitly disabled + real forced choice; `llm.forceSubmitToolChoice` escape hatch honored).
2. **Reasoning/thinking mapping** — `mapReasoningOptions` per API family (`thinkingEnabled`/`effort` on anthropic-messages, `reasoningEffort` on openai-responses, google thinking levels).
3. **Auth resolution order** — env key → stored `api_key` → stored OAuth (with refresh + persist via oauth helpers). codegenie owns this order; the new API's `models.getAuth()` must either reproduce it exactly or NOT be adopted (explicit per-call `apiKey` injection is the fallback design).
4. **Per-call observability hooks** — `onResponse` (TTFB + rate-limit headers; moved to `api/anthropic-messages` in 0.80.3, verified present), `onPayload` (openai-responses tool-choice injection), `maxRetries: 0` (codegenie owns retries), `signal`, `sessionId`/`cacheRetention` (per-worker session keys; `prompt_cache_key` on OpenAI).
5. **Catalog semantics** — `getModel/getModels/getProviders` results identical for the providers codegenie exposes (`provider models`, model resolution incl. `provider/model` qualified ids).
6. **`validateToolCall`** — same validation source (`utils/validation`, still on the root entrypoint).

## Design

Phased, each phase independently landable and testable; the adapter seam (`PiAiAdapter` — `resolveModel`/`complete`/`validateToolCall`) means phases 1-2 touch no wire behavior at all.

**Phase 0 — golden capture.** Before any change: record the protocol baseline. One harness run per case (or reuse the latest runs) keeping `provider_protocol` events + per-call records (`toolChoiceRequested/Effective`, `reasoningMechanism`, `ttfbMs` presence, `rateLimit` keys) as the reference. Unit-level: the phase4 adapter tests already pin `mapProviderOptions` outputs (forced anthropic: `thinkingEnabled: false` + `{type:"tool",name}`; flag-off: `thinkingEnabled: true` + `"auto"`) — these are the contract tests and must not change in the migration commits.

**Phase 1 — catalog reads.** Build one `Models` instance (or use `getBuiltinModel/getBuiltinModels/getBuiltinProviders` from `providers/all`) in `provider-services.ts`; route `getModel/getModels/getProviders` through it in both files. No auth, no calls. Deletes three `/compat` imports.

**Phase 2 — auth reconciliation.** Decision (make it explicitly, in-plan, during implementation):
   - **Option A (default): keep codegenie-owned resolution.** `resolveProviderAuth`/`resolveModelApiKey` stay as-is; calls keep passing explicit `apiKey`. Only the oauth helper imports move to their new home if upstream relocates them. Minimal risk; `models.getAuth()` unused.
   - **Option B: implement pi's credential-store contract** backed by `getCodegeniePaths().authPath` and let `models.getAuth()` resolve. Adopt ONLY if the contract can express codegenie's exact order (env → api_key → oauth-with-refresh-persist) and the provider CLI (`login --api-key`, `auth-status`, OAuth device flow) behaves identically. If anything bends, fall back to Option A.
   `getEnvApiKey` (compat) → the env-api-keys module direct import or a 10-line local lookup — codegenie's env-key table is small and stable; owning it locally removes a dependency edge.

**Phase 3 — the call path.** `createRealPiAiAdapter` switches `completeFn`/`completeSimpleFn` from compat dispatch to the new call surface (per-API `stream`/`streamSimple` from `api/anthropic-messages` etc., or `models.stream` — choose whichever accepts the same options object verbatim; compat re-exports the same implementations, so the options shape is already aligned). `mapProviderOptions`/`mapProviderToolChoice`/`mapReasoningOptions` are codegenie-owned and move unchanged. The forced-vs-simple branch stays. Confirm `onResponse`, `onPayload`, `sessionId`, `cacheRetention`, `maxRetries`, `signal` reach the provider identically (they are `StreamOptions` fields, not compat-isms).

**Phase 4 — tests.** Adapter-injection fakes keep working untouched (they mock codegenie's seam, not pi). Direct pi type imports in phase4 tests move to root-entrypoint equivalents; oauth mocks re-point. If any test needs a real registered provider, use `fauxProvider()` + `models.setProvider` instead of compat's `registerFauxProvider`.

**Phase 5 — flip and unpin.** Remove the last `/compat` imports, run the full validation protocol, unpin pi-ai (allow ^0.81+ or whatever upstream ships), and delete the punchlist pin note.

## Validation protocol (the gate for phases 3+5)

1. Full unit suite + typecheck + build (the phase4 protocol-contract tests unchanged and green).
2. **A/B harness run** (owner-run): same case, same config, pre/post-migration commits. Diff per-call: `toolChoiceRequested/Effective`, `toolChoiceDowngraded`, `reasoningMechanism`, `forceSubmitToolChoice`, `sessionKeyGranularity`, presence of `ttfbMs`/`rateLimit`/`providerRequestId`. Requirement: **identical protocol posture** (wall-clock and token counts vary run-to-run; protocol fields must not).
3. Provider CLI: `auth-status` for api-key and oauth entries; `login --api-key` round-trip; model listing identical.
4. `debugTrace` request-payload spot-check on one anthropic and (if authenticated) one openai call: same params shape (thinking config, tool_choice, prompt_cache_key/session headers).

## Non-Goals

- Any behavior change riding along (tool-choice, reasoning, retries, session keys — all frozen; that is what plans 86/84 own).
- Multi-provider collections/handoffs, dynamic providers, image APIs — codegenie uses none of them.
- Upgrading pi-ai beyond 0.80.x before phase 5 completes.

## In-Scope Files

- `src/llm/pi-runner.ts`, `src/provider/provider-services.ts` — import surface + adapter internals.
- `src/llm/llm-runner.ts` — `TSchema` type import (root entrypoint already; likely untouched).
- `tests/phase4-llm.test.ts` — type imports, oauth mocks, possible `fauxProvider` adoption.
- `package.json` — the version pin (phase 5).
- `specs/project/components/skills_llm_telemetry.md` — note the migration in the provider matrix once landed.

## Implementation Steps

1. Phase 0 golden capture (free if the latest eval runs are kept as reference).
2. Phase 1 catalog reads; commit.
3. Phase 2 auth decision + implementation; commit. Record the Option A/B decision and why in this plan's status block.
4. Phase 3 call path; commit; run validation items 1, 3, 4.
5. Phase 4 tests; commit.
6. Phase 5 flip + owner A/B run (validation item 2) + unpin; commit; update punchlist.

## Done Criteria

- Zero `@earendil-works/pi-ai/compat` imports; pi-ai unpinned.
- Validation protocol green, including the A/B protocol-posture diff.
- Auth decision documented; provider CLI behavior unchanged.

## Stop Conditions

- If the new surface cannot express any preserved-contract item (e.g. `onResponse` semantics change, per-call `apiKey` injection unsupported, forced tool choice mapped differently), STOP, stay pinned on `/compat`, and file the gap upstream — compat is documented-temporary but functional; a protocol regression is not an acceptable trade for import hygiene.
- If the A/B diff shows any protocol-field drift, revert the flip commit and diagnose before retrying — never ship "close enough" on this seam.
