---
status: complete
---

# Phase 0: Standalone PR-head CI prerequisite

## Overview

Add an ordinary pull-request CI lane that validates the untrusted PR head independently of the trusted-base codegenie dogfood workflow. The lane installs a version- and checksum-pinned `actionlint` before any repository gate, performs the frozen pnpm install with dependency scripts governed by `pnpm-workspace.yaml`, and then runs the repository check, test, and build commands. The existing dogfood workflow remains unchanged so it continues to build and execute the reviewer from the trusted base revision.

## Steps

1. Add `.github/workflows/ci.yml` with a `pull_request` trigger, read-only contents permission, an explicit `${{ github.event.pull_request.head.sha }}` checkout, Node 26 setup, and pinned pnpm setup.
2. In `.github/workflows/ci.yml`, download `actionlint` v1.7.12 for Linux amd64, verify its published SHA-256 digest, add its directory to `GITHUB_PATH`, and verify the binary before any check or test step.
3. Install dependencies with exactly the script-enabled `pnpm install --frozen-lockfile` policy, then run `pnpm run check`, `pnpm test`, and `pnpm build` as ordered, separately visible gates.
4. Extend `tests/github-action.test.ts` with a structural contract test that pins PR-head checkout, actionlint version/checksum installation and ordering, frozen installation without `--ignore-scripts`, and the ordered check/test/build commands while retaining the existing trusted-base dogfood assertions.

## Tests

- `runs standalone CI against the PR head with actionlint available before every gate`: parses the workflow and verifies PR-head checkout, the pinned and checksum-verified actionlint install precedes check/test, dependency installation is frozen and script-enabled, and check/test/build all run in order.
- `pnpm run check`: type-checks the workflow contract test and validates all workflows with `actionlint`.
- `pnpm test`: exercises the new workflow contract along with the full test suite.
- `pnpm build`: proves the distributable TypeScript build remains clean.
