# Releasing

`@0xsequence/codegenie` releases are CI-staged: pushing a version tag makes
[`.github/workflows/release.yml`](.github/workflows/release.yml) verify the
tag, typecheck, build, and **stage** the tarball on npm via
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).
There is no `NPM_TOKEN` secret to manage, and provenance attestations are
generated automatically. The trusted publisher is **stage-only** — a package
maintainer must approve the staged release with 2FA before it goes live.
Never publish or stage from a local machine.

## One-time setup (npm package owner)

Someone with owner/maintainer access to `@0xsequence/codegenie` on npmjs.com
must connect the package to this repository as a **stage-only** trusted
publisher:

1. Go to the package on npmjs.com → **Settings** → **Trusted Publisher**.
2. Select **GitHub Actions** and enter:
   - Organization or user: `0xPolygon`
   - Repository: `codegenie`
   - Workflow filename: `release.yml`
   - Environment: leave empty (the workflow does not use one)
3. Register it **stage-only** (`--allow-stage-publish`, no
   `--allow-publish`), so CI can stage but never publish directly.
4. Set the package's publishing access to *Require two-factor
   authentication* so token-based publishes are disallowed.

Until this is done, the release workflow fails at the staging step with an
authentication error — everything else (version check, typecheck, build)
still runs, so the workflow can be dry-run validated by pushing a tag
before the npm side is configured. If the package later moves out of the
`@0xsequence` scope, the trusted-publisher entry must be recreated on the
new package name.

## Cutting a release

1. Bump `version` in `package.json` on `master` (via the normal PR flow).
2. Tag the release commit and push the tag:

   ```bash
   git checkout master && git pull
   git tag v$(node -p "require('./package.json').version")
   git push origin v$(node -p "require('./package.json').version")
   ```

3. The `Release` workflow verifies the tag matches `package.json`, builds,
   and stages the tarball with provenance.
4. A maintainer inspects and approves the staged release. The `npm stage`
   commands need npm >= 11.15.0 (staged-publishing support) — the same
   version the workflow pins:

   ```bash
   npm install -g npm@11.15.0
   npm stage list @0xsequence/codegenie
   npm stage view <stage-id>
   npm stage approve <stage-id>   # prompts for 2FA
   ```

The tag must be `v<version>` and match `package.json` exactly (e.g. `v0.5.2`
for version `0.5.2`); the workflow fails otherwise.

If staging fails partway, reject the partial stage with
`npm stage reject <stage-id>` before retrying — staging reserves the
package version.

## Notes

- The full test suite is not re-run in the release workflow (it needs
  actionlint and Foundry); CI on the PRs that land on `master` is the test
  gate. The release workflow still typechecks and builds from scratch.
- The GitHub Action (`action.yml`) installs the npm package at the version
  pinned in `package.json` of the referenced tag, so publishing to npm is the
  only deployment step — action users pick it up by referencing the new tag.
