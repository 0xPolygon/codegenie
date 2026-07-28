# Releasing

`@0xsequence/codegenie` is published to npm automatically by
[`.github/workflows/release.yml`](.github/workflows/release.yml) when a
version tag is pushed. Publishing uses
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC):
there is no `NPM_TOKEN` secret to manage, and provenance attestations are
generated automatically.

## One-time setup (npm package owner)

Someone with owner/maintainer access to `@0xsequence/codegenie` on npmjs.com
must connect the package to this repository:

1. Go to the package on npmjs.com → **Settings** → **Trusted Publisher**.
2. Select **GitHub Actions** and enter:
   - Organization or user: `0xPolygon`
   - Repository: `codegenie`
   - Workflow filename: `release.yml`
   - Environment: leave empty (the workflow does not use one)
3. Save. Optionally set the package's publishing access to
   *Require two-factor authentication or a trusted publisher* (or trusted
   publisher only) so token-based publishes are disallowed.

Until this is done, the release workflow will fail at the `npm publish` step
with an authentication error — everything else (version check, build) still
runs, so the workflow can be dry-run validated by pushing a tag before the
npm side is configured. Note: if the package later moves out of the
`@0xsequence` scope, the trusted-publisher entry must be recreated on the new
package name.

## Cutting a release

1. Bump `version` in `package.json` on `master` (via the normal PR flow).
2. Tag the release commit and push the tag:

   ```bash
   git checkout master && git pull
   git tag v$(node -p "require('./package.json').version")
   git push origin v$(node -p "require('./package.json').version")
   ```

3. The `Release` workflow verifies the tag matches `package.json`, builds,
   and publishes with provenance.

The tag must be `v<version>` and match `package.json` exactly (e.g. `v0.5.2`
for version `0.5.2`); the workflow fails otherwise.

## Notes

- The full test suite is not re-run in the release workflow (it needs
  actionlint and Foundry); CI on the PRs that land on `master` is the test
  gate. The release workflow still typechecks and builds from scratch.
- The GitHub Action (`action.yml`) installs the npm package at the version
  pinned in `package.json` of the referenced tag, so publishing to npm is the
  only deployment step — action users pick it up by referencing the new tag.
