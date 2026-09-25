# Issue 125: GitHub Action Model Aliases and Provider Credential Docs

Status: IMPLEMENTED (dogfood pending)
Based on: owner request (2026-09-25) for a set of named models in the Action, selectable per comment trigger
Depends on: plan 97 (GitHub Action adapter, trust model, status comment); `src/provider/pi-ai-models.ts` env-key routing

## Objective

Let a workflow author configure several named models once. The configured default runs automatic reviews and bare trigger comments. A collaborator can pick another configured model for one run by writing `<trigger-phrase> <alias>` (e.g. `codegenie review opus`). At the same time, document every provider credential env var from the table codegenie actually reads, and fix the drift in that table.

Workflows that use only `model` + `llm-api-key` keep working, with one deliberate change: **`llm-api-key` now takes precedence**. If it is set, it is the only model key used and it overrides provider env vars. If it is not set, provider credentials resolve exactly as today.

Target surface, with several providers (per-provider env vars, no `llm-api-key`):

```yaml
- uses: 0xPolygon/codegenie@<next tag>
  env:
    # Credential env var per provider: see models.md#credentials
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    ANTHROPIC_API_KEY:  ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    model: deepseek          # default: automatic reviews + bare "codegenie review"
    models: |
      deepseek: openrouter/deepseek/deepseek-v4.1-flash:max
      astra:    openrouter/openai/gpt-6-astra:medium
      glm:      openrouter/z-ai/glm-5.3:max
      opus:     anthropic/claude-opus-5
```

With a single provider, one `llm-api-key` covers every alias:

```yaml
  with:
    model: deepseek
    models: |
      deepseek: openrouter/deepseek/deepseek-v4.1-flash:max
      glm:      openrouter/z-ai/glm-5.3:max
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

The simple form is unchanged: `model: "openrouter/deepseek/deepseek-v4.1-flash:max"` + `llm-api-key: ${{ secrets.LLM_API_KEY }}`.

## Evidence and constraints

1. **Action inputs are strings.** A mapping under `with:` fails workflow validation, so `models` must be a block string that codegenie parses. `models` holds model specs only; keys never go in it.
2. **Trailing comment text is ignored today.** `matchesTriggerPhrase` accepts `<phrase>` followed by whitespace and discards the rest (`src/github-action/event-gate.ts`). Plan 97 (line 88) deferred comment-driven options to "an allowlisted grammar if ever wanted". This plan is that grammar: a closed-set lookup into aliases defined by the workflow author. Comment text never becomes a model spec, reasoning level, or flag.
3. **`llm-api-key` currently loses to env vars, and follows whichever model is selected.** `applyGenericApiKey` copies `LLM_API_KEY` into the selected provider's env var only when that var is empty, so a stale `ANTHROPIC_API_KEY` in the job env silently beats the key the workflow passed explicitly. The owner wants the reverse: an explicitly passed `llm-api-key` is authoritative. Separately, with aliases, one key would be copied into whatever provider the selected alias uses. An OpenRouter key would land in `ANTHROPIC_API_KEY` for `codegenie review opus` and fail with a confusing provider 401.
4. **The missing-credential error gives CLI advice in CI.** `adapter.resolveModel` (`resolveRealModel`) returns the same `undefined` for an unknown model, a deprecated model, a provider with no usable credentials, and any swallowed exception. `createPiRunner` then throws `no usable LLM model could be resolved; run codegenie provider login <provider>…` (`src/llm/pi-runner.ts:220`). The status comment's failure body shows only the error code and a provider message (`renderFailureBody`), so a CI user sees `config_error` and nothing actionable.
5. **The provider→env-var table has drifted.** `API_KEY_ENV_VARS` in `src/provider/pi-ai-models.ts` is a hand copy of pi-ai's table (pi-ai 0.87.1 does not export `env-api-keys`). It lacks `qwen-token-plan` / `qwen-token-plan-cn` / `qwen-token-plan-individual` (`QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY`), `baseten`, `meta` and `radius`. The two qwen providers are listed in `models.md` today. Their env keys are never read, and `llm-api-key` fails for them with "provider does not accept an API key". No test covers the table.
6. **Credential names are undocumented and non-uniform.**
   - Unusual names: `google` → `GEMINI_API_KEY`, `vercel-ai-gateway` → `AI_GATEWAY_API_KEY`, `huggingface` → `HF_TOKEN`, `github-copilot` → `COPILOT_GITHUB_TOKEN`.
   - Shared names: `moonshotai*` → `MOONSHOT_API_KEY`, `opencode*` → `OPENCODE_API_KEY`, `cloudflare-*` → `CLOUDFLARE_API_KEY`.
   - Other credentials: `amazon-bedrock` uses AWS credentials or OIDC; `google-vertex` uses `GOOGLE_CLOUD_API_KEY`, or ADC + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`.
   - `openai-codex` has only a stored OAuth login, which works on a runner only where someone ran `codegenie provider login` (self-hosted).
7. **The examples need two copies of the list.** The automatic and comment examples are separate workflow files. The dogfood workflow (`.github/workflows/codegenie-review.yml`) already shows that one workflow can serve both events without changing the trust model. `ref: ${{ github.event.pull_request.base.sha || '' }}` checks out the base SHA on `pull_request` and the default branch on `issue_comment`, and the concurrency group is keyed by `pull_request.number || issue.number`.

## 1. Model aliases in the Action

### Configuration

- New input `models`: a block string holding a flat YAML mapping of `alias: provider/model[:reasoning]`. Parse it with the existing `yaml` dependency. Reject anything other than string keys mapped to string values (no nesting, anchors or lists). Blank input means no aliases.
- Alias names accept ASCII letters in either case: `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`. Normalize to lowercase before duplicate checks, storage and lookup, including the default `model` alias. `Opus` and `opus` are duplicates; a comment requesting `OPUS` selects `opus`.
- Each value must pass `parseModelSpec` **with** a provider prefix, and the provider must exist in the registry. The whole block fails if any entry is invalid, since that is an error in the workflow file. Such a config error fails every run, including automatic reviews, with an Actions log message naming the line and alias.
- Preserve `splitReasoningSuffix` semantics:
  - Only a recognized reasoning suffix (including `auto`) is separated from the model id.
  - Other suffixes, such as `:free` or `:8b`, remain part of the id.
  - A typo such as `:hgh` therefore surfaces as an unknown model when that alias is selected (see Credentials), not as an alias-parse error.
  - Model-specific reasoning handling stays in the existing review path.
- `model` stays the single source of the default. It accepts either an alias name or a full spec. If `models` is set:
  - `model` is required.
  - A `model` value without a `/` must name an alias; otherwise it is a config error, because it is almost certainly a typo.
  - Without `models`, `model` parsing is unchanged.
- There is no reserved `default` alias and no per-alias setting beyond the spec.

### Trigger grammar

- `event-gate.ts` stays pure. On a phrase match it also returns `requestedAlias`: the first whitespace-delimited token on the **first line** after the phrase, lowercased, or none. Later lines and later tokens are ignored, so `codegenie review\n\nfocus on auth` still means "default".
- Resolution happens in the entrypoint, **after** the payload authorization and the live write-permission check, so unauthorized commenters never get a reply:

| `models` set? | Comment | Result |
| --- | --- | --- |
| no | any match | Today's behavior: `model`, trailing text ignored |
| yes | `<phrase>` | default (`model`) |
| yes | `<phrase> <alias>` | that alias |
| yes | `<phrase> <other token>` | reply (below), no review |

- The `pull_request` lane always uses the default.
- Comments never accept raw specs, `:reasoning` suffixes or extra flags. Authors who want a reasoning variant define an alias for it (`opus-max: anthropic/claude-opus-5:max`).

### Unknown alias reply

- Post one **new** plain comment with `createComment`. The status comment is never touched, so the last report stays intact, and the reply carries no status marker, so it can never be reclaimed.
- Fixed text built only from the configured alias names, e.g. ``Unknown model. Available: `deepseek` (default), `astra`, `glm`, `opus`.`` The commenter's token is not echoed. Alias names are restricted to `[A-Za-z0-9._-]`, so the body needs no sanitizing beyond the normal posting path.
- The run ends as a skip (exit 0) with decision reason `unknown model alias`.

### Preflight

- `preflight-only` authorizes the event and resolves the alias. For an unknown alias it posts the reply and sets `should-run=false`, so the reply is posted once. It needs no LLM credentials.
- Credential handling (below) happens only in the review invocation. A two-job workflow must pass the same `model` / `models` / trigger inputs to both jobs; the review job repeats authorization and resolution.

### Credentials

There are two modes, chosen by whether `llm-api-key` is set (the input, or `LLM_API_KEY` in the step env, as today).

**`llm-api-key` set: it is the only key.**

- Every selectable model (the default and every alias) must share one provider, and that provider must accept an API key. Check the whole set regardless of which alias was selected, and fail with a config error otherwise:

  > llm-api-key is a single key, but models use providers openrouter, anthropic. Remove llm-api-key and set each provider's env var (see models.md#credentials).

  A key that works for some aliases and 401s for others is worse than failing up front.
- Routing:
  - Unset that provider's other credential env vars: every name in its table entry, plus `ANTHROPIC_AUTH_TOKEN` for Anthropic. pi's Anthropic auth checks `ANTHROPIC_AUTH_TOKEN` first and sends it as a Bearer header.
  - Then write the key into the provider's API-key env var unconditionally.
  - Other providers' vars are left alone.
  - Amendment (implementation review, owner decision 2026-09-25): the original claim here was wrong. codegenie's `resolveProviderAuth` checks env first, but in production pi-ai's own auth resolution (`dist/auth/resolve.js`) lets a stored credential own its provider ahead of env vars, because `complete()` passes no explicit `apiKey`. So when `llm-api-key` is routed and the runner has a stored codegenie login for that provider (self-hosted runners only), the Action fails before claiming the status comment, telling the user to run `codegenie provider logout <provider>` or unset `llm-api-key`. The Action-only guard was chosen over passing the key to pi explicitly, which would also flip CLI precedence (env over stored login) and could silently change CLI billing.
- Providers without an API key (`amazon-bedrock`, `openai-codex`) keep today's error ("does not accept an API key").

**`llm-api-key` not set:** resolution is unchanged (env vars, then ambient credentials, then any stored login), with no Action-specific pre-check and no new policy. Aliases that are not selected are never touched, so a missing Anthropic key never breaks an automatic review whose default uses another provider.

**A clear error when credentials are missing.** This one fix serves both the CLI and CI:

- Keep the failure reason where resolution happens. `resolveRealModel` (`src/llm/pi-runner.ts`) currently returns `undefined` for four different failures: a model missing from the registry, a deprecated model (`isDeprecatedProviderModel`), a provider without credentials, and any exception swallowed by its `catch {}`. Have it report which one occurred (a small reason alongside the `undefined` result; the resolution logic itself is unchanged), so `createPiRunner` can pick the message:
  - unknown model: "unknown model `provider/id`";
  - deprecated model: "model `provider/id` is deprecated";
  - missing credentials: "no credentials for provider `anthropic`: set `ANTHROPIC_API_KEY` (or run `codegenie provider login anthropic`)";
  - unexpected error: today's generic message, unchanged. Never label it missing credentials.

  All four keep the existing `config_error` code; only the message text changes.
- Take the env var name(s) from the phase 2 table, and use the ambient note for Bedrock, Vertex and Codex.
- This fires after the status comment is claimed. It reaches the PR through the existing failure path, the same way any failed run replaces the status comment today.
- `renderFailureBody` renders the message only for these model-resolution errors, not for codegenie errors in general, which can carry git stderr, paths or other external text. The message can still include workflow-supplied model ids, so pass it through `scrubGitHubSecrets`.
- Sanitize the whole failure body. Today `finalizeFailure` sends `renderFailureBody` output to GitHub without `sanitizeGitHubCommentBody` (only the success report path is sanitized, `src/github-action/status-comment.ts`), so an existing provider message can carry mentions or HTML. Wrapping the rendered failure body in the existing sanitizer closes that gap and covers the new message. No new reply path and no new helpers.

**Compatibility.**

- Single-model workflows that set only `llm-api-key`, or only native env vars, behave as before.
- When both are set with different values for the same provider, `llm-api-key` now wins. Document this in the README and release notes, and update the `action.yml` `llm-api-key` description.
- The `inputs.llm-api-key || env.LLM_API_KEY` fallback in `action.yml` stays.

No other new key input. A provider-keyed `llm-api-keys` input is a Future Consideration, only if env var names prove to be a real stumbling block after phase 2's docs.

### Wiring

- `action.yml`:
  - Add the `models` input and pass it as `--models "$INPUT_MODELS"` (no secrets, so argv is fine).
  - Update the `model` description: alias or spec.
  - Update the `llm-api-key` description: when set, it is the only model key and overrides provider env vars; all selectable models must share its provider.
- `parseGitHubActionArgs`: accept `--models`, and validate the combination with `model` after all flags are parsed.
- Add `modelAlias` and the resolved `modelSpec` to the decision and lifecycle records. The report already renders `🤖 Model:`, and the trigger comment shows who asked, so there is no extra rendered line.
- No new flags on `codegenie review`. The synthesized argv is unchanged in shape: `--provider/--model/--reasoning` from the resolved spec.

### Tests and acceptance

- `models` parsing:
  - Valid blocks, including quoted values, comments and blank lines.
  - Mixed-case aliases normalize consistently; case-insensitive duplicates, bad names, nested or list values are rejected.
  - Missing provider prefix and unknown provider are rejected. Recognized reasoning suffixes parse normally; colon-bearing ids stay intact: `…:free` parses as model id ending in `:free` with the default reasoning, and `…:free:high` as model id ending in `:free` with reasoning `high`.
  - YAML syntax errors.
- `model` resolution: an alias name, a full spec, a slash-less `model` that is not an alias while `models` is set, and a missing `model` while `models` is set.
- Gate: the token extracted from the first line only; multi-line comments; a phrase inside a longer word (still no match); unchanged behavior when `models` is absent.
- Entrypoint:
  - The PR lane uses the default.
  - A bare comment uses the default; an alias comment produces the alias's argv.
  - An unknown alias posts exactly one reply, with no status claim, no review and exit 0.
  - An unauthorized actor with an unknown alias is skipped silently.
  - `preflight-only`: an unknown alias gives `should-run=false` plus one reply; a known alias passes without LLM credentials.
- Credentials:
  - With `llm-api-key` set, it overrides a different pre-set native var for the same provider, and the competing vars are unset. The resolved key equals `llm-api-key` even with a stored credential present. Tests isolate `process.env`, because `providerEnvValue` falls back to it.
  - Models spanning several providers with `llm-api-key` set fail with the config error.
  - A single-provider alias set works for every alias.
  - A keyless provider errors as before.
  - With `llm-api-key` unset, each alias uses its own provider's native var.
  - Resolution failures are labeled correctly:
    - an unknown model id gives the unknown-model message;
    - a deprecated model gives the deprecated message;
    - a known model without credentials gives the provider + env-var message in the status comment's failure body;
    - an unexpected resolver exception gives the generic message, not "missing credentials".
  - Failure-body sanitizing: a failure message containing an `@mention`, HTML comment and a secret-shaped string renders with the mention neutralized, the HTML stripped and the secret scrubbed. This covers both the new message and an existing provider message.
- Compatibility regression: the README's simple form (`model: openrouter/deepseek/deepseek-v4.1-flash:max`, `llm-api-key` set, no `models`) produces the same argv, the same `OPENROUTER_API_KEY`, and the same ignored trailing comment text as before. Also cover the native-env-only form (`OPENROUTER_API_KEY` in step env, no `llm-api-key`).
- Workflow shape: the merged example passes `actionlint`.

Acceptance:

- An existing single-model workflow produces identical argv and behavior, except that `llm-api-key` now wins over a conflicting native var for the same provider.
- With aliases, every authorized matching comment either runs a model the workflow author listed or gets the fixed reply. Unauthorized commenters get no reply.

Likely files: `src/github-action/event-gate.ts`, `src/github-action/entrypoint.ts`, a small `src/github-action/models.ts` (parse and resolve), `src/github-action/render.ts`, `src/llm/pi-runner.ts` (resolution reason and messages), `src/github-action/status-comment.ts` (failure-body sanitizing), `action.yml`, `tests/github-action.test.ts`.

## 2. Provider credential table: fix, guard, document

### Fix and guard

- Sync `API_KEY_ENV_VARS` with pi-ai 0.87.1: add `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `baseten`, `meta` and `radius`.
- Keep the existing, deliberate exclusion of `ANTHROPIC_AUTH_TOKEN` from the lookup: pi's `getEnvApiKey` also skips it because it is bearer auth, and `getPiEnvApiKey` returns the first var it finds. Phase 1's routing unsets it separately.
- Add a small ambient-credential note table in the same module for `amazon-bedrock`, the ADC path of `google-vertex`, and `openai-codex` (stored login; self-hosted runners only). Export only what the generator, the phase 1 error and the coverage test need.
- **Registry coverage test:** every provider from `createPiModelRegistry(...).listProviders()` has env var names or an ambient note. This catches the drift actually observed: a provider added upstream with no key mapping.
- Future Consideration: ask pi-ai upstream to export its env-key table, then delete our copy. Deletion is the success outcome.

### Document

- `scripts/write-models-md.mjs`:
  - Emit one `## Credentials` table near the top of `models.md`: provider → env var(s), or its ambient note.
  - Replace the header sentence that mentions "env vars / the Action's `llm-api-key`" with a link to it.
  - Regenerate `models.md`.
- README, GitHub Action section:
  - Show the multi-model example above plus the unchanged simple form.
  - Add a short credentials table for the common providers (anthropic, openai, openrouter, google → `GEMINI_API_KEY`, bedrock, vertex), flag the names that break the pattern, and link to `models.md#credentials`.
  - Document:
    - the alias grammar and the unknown-alias reply;
    - the two credential modes: `llm-api-key` is the only key when set and needs a single-provider model set; otherwise provider credentials resolve as usual;
    - the precedence change;
    - concurrency and the status comment: a `codegenie review opus` comment supersedes an in-flight run on the same PR (newest event wins), and the single status comment shows the newest report.
  - **Note: a typo'd alias still cancels an in-flight review.** `codegenie review opsu` starts a run that supersedes the running one, then only posts the reply. This is the same "any comment supersedes" residual plan 97 accepted.
  - **Note: inline comments accumulate across models.** A `review opus` run after an automatic review posts its own inline findings. Duplicate suppression only matches unchanged prose, so two models reporting the same issue both appear. This is expected for a second opinion.
- Examples:
  - Replace `codegenie-review-pr.yml` and `codegenie-review-comment.yml` with one `examples/workflows/codegenie-review.yml` that has both triggers, using the dogfood workflow's `ref` and concurrency expressions.
  - Keep the trust-model and cancellation comments.
  - Show the `models` block and native env keys, with a `# see models.md#credentials` pointer.
  - Keep the simple single-model form as a commented alternative.
  - Update README references to "both trigger lanes".
- Dogfood workflow: works unchanged. Adding aliases there needs repository secrets and is the owner's call, not part of this implementation.

### Tests and acceptance

- The coverage test fails on the pre-fix table and passes after the sync.
- `models.md` regenerates deterministically and its Credentials table lists every provider.

## Implementation and validation order

1. Phase 2 fix and guard first: it is a standalone bug fix, and phase 1's missing-credential message needs the env var names.
2. Phase 1: parsing, gate token and resolution, the reply, `llm-api-key` routing and the error split, then wiring and records.
3. Generator, `models.md` regeneration, README and the merged example.
4. Run `pnpm test`, `pnpm run typecheck`, `pnpm run build`, `make models-list` and `git diff --check`. Review for:
   - comment text reaching argv beyond a listed alias;
   - replies to unauthorized actors;
   - `llm-api-key` precedence (it wins, and no competing credential for that provider remains readable);
   - model-id suffix compatibility and case-insensitive alias resolution;
   - any change to single-model behavior.
5. Dogfood on a test PR, run by the owner. Try a bare trigger, an alias trigger, an unknown alias, and an alias whose provider credentials are missing. Check the reply text, the status comment, and the decision/lifecycle records. Release follows the plan 97 order (npm before tag).

## Scope and non-goals

- No per-alias access control; the author's list is the allowlist and the cost control.
- No comment-supplied specs, reasoning levels or flags.
- No per-alias status comments, and no `llm-api-keys` input in this iteration.
- No Action-specific credential pre-check or stored-login policy, beyond the narrow `llm-api-key` stored-login guard (see the Credentials amendment).
- No aliases in `codegenie.toml` or the CLI.
- No review-pipeline, prompt or model-facing changes.
- Harness touches stay within the plan 97 seams, plus `pi-ai-models.ts` exports (existing seam), the `resolveRealModel` failure reason and `createPiRunner` messages, and the docs generator.

## Separate follow-up (not this plan)

- Unverified and older than this plan: with a custom GitHub App token, creating the status comment on the first run is itself an `issue_comment` event. GitHub starts workflows for App-token events, not for `GITHUB_TOKEN`. The new run skips as a bot, but under `cancel-in-progress: true` it may cancel the review that created the comment. Verify with an App-token setup; fix under plan 97 if confirmed.

## Implementation and review results

- **Aliases:** `src/github-action/models.ts` parses `models` with the YAML failsafe schema (every scalar is a string, so `405:` stays a name), resolves `model` as an alias or spec, selects the comment-requested alias, and renders the fixed unknown-alias reply. The event gate returns the first token on the trigger phrase's line. The entrypoint resolves it only after the live permission check. Decision and lifecycle records carry `modelAlias`/`modelSpec`.
- **`llm-api-key`:** it clears the provider's credential vars (including `ANTHROPIC_AUTH_TOKEN`), writes the key unconditionally, requires one API-key provider across all selectable models, and refuses when the runner has a stored login for that provider (amendment above).
- **Resolution errors:** `resolveRealModel` keeps its reason. The real adapter exposes it through an optional `explainUnresolvedModel`, so test adapters are unchanged. `createPiRunner` reports unknown model, deprecated model, missing credentials (naming the env var) or the unchanged generic message, all as `config_error` with `context.modelResolution`. The Action publishes only those messages, scrubbed and capped. The failure JSON gets a separate `modelResolution` field. The whole failure comment is now sanitized.
- **Credentials table:** synced with pi-ai 0.87.1, plus ambient notes and a registry coverage test. `models.md` gained a generated Credentials table. Regenerating it also caught up with the installed registry: 1103 → 1490 models, 37 → 41 providers. The table sync matters because `baseten`, `meta`, `radius` and `qwen-token-plan-individual` are live providers.
- **Docs and examples:** README, `action.yml` and one merged example workflow. The owner's in-flight switch of the example default to `openrouter/openai/gpt-6-luna:xhigh` was carried into the merged example as the `luna` alias.
- **Independent review (fresh agent, adversarial):**
  - Found that pi-ai's stored-credential-first auth bypasses `llm-api-key` on self-hosted runners with a stored login. Resolved by the owner-chosen Action guard.
  - Found that a nonexistent provider was reported as "missing credentials". Fixed: it now gets the generic message.
  - Found that numeric alias names were rejected. Fixed with the failsafe schema.
  - Pins: the example and README pins stayed `@v0.6.3` (no `models` input) until the package was bumped to 0.7.0 on this branch; they now pin `@v0.7.0`, as the existing contract test requires. The optional adapter method (rather than a reason-returning `resolveModel`) was kept to avoid touching the ~40 test adapters.
  - Sound: the trust boundary, secrets on every published surface, backward compatibility and error labeling on the Action path.
- **Mutation checks:** removing the failure-body sanitizer, or the credential clearing, fails the new tests.

Validation: `pnpm test` passed **1,583 tests across 69 files**, including actionlint on the merged example. `make evals` passed **39 synthetic tests**. Typecheck, build and `git diff --check` passed, and `models.md` regenerates identically. The built CLI printed the missing-credentials, unknown-model and deprecated-model messages on a real commit range, failing before any model call. No paid inference, pushes or GitHub posts were made. Dogfooding on a test PR (bare trigger, alias, unknown alias, alias with missing credentials) and the release remain with the owner.

### Follow-up PR review (#37)

A second high-effort review of the PR diff led to these changes (owner-approved; the stored-login guard is kept):

- **One env var, not one provider.** The `llm-api-key` single-key rule now requires every selectable model to read the same API-key env var, not the same provider id. Provider pairs that share a var (`moonshotai`/`moonshotai-cn`, `opencode`/`opencode-go`, the two `cloudflare-*` providers) work with one key. Competing vars are cleared, and the stored-login guard runs, for every routed provider.
- **Validate after the trigger gate.** `model`/`models` are validated after the trigger gate instead of at flag parsing. A broken block still fails every real trigger, including every push, but unrelated comments ("LGTM") skip instead of failing.
- **Record types restored.** The decision-record union is back to discriminated variants (authorized, denied, unknown alias), so impossible records don't type-check.
- **Shared provider check.** Alias validation reuses `providerKnown` from `provider-services.ts`, which is now exported, instead of its own copy.
- **Token normalization in one place.** The event gate is the only place the alias token is normalized. It lowercases the token and strips surrounding quotes, backticks and brackets plus trailing punctuation, so `` `opus` `` and `opus.` select `opus`. To keep every alias reachable after that stripping, alias names must now start and end with a letter or digit.
- **Unchanged, as by-design or owner decisions:**
  - Other words after the phrase get the reply when `models` is set.
  - Pre-claim configuration errors reach only the job log, as an invalid `model` always did.
  - The stale "Reviewing…" comment left by any superseding comment is the plan 97 residual.
  - The optional `explainUnresolvedModel` re-resolution is kept.
  - An Action-only explicit-key alternative to the stored-login guard exists, but it needs a new path for the key into the review; the owner kept the guard.
