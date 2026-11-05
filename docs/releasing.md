# CI and release guide

## Contents

[Current state](#current-state) · [CI](#ci) · [Prepare a candidate](#prepare-a-candidate) · [Publish](#publish) · [Failures and recovery](#failures-and-recovery)

## Current state

The package remains private at `0.0.0-m0`. This change prepares workflows and
release checks; it does not select a license/version, push tags or publish npm.
The current package is expected to fail release preflight. Library users can
continue consuming a checkout or private development tarball.

## CI

`.github/workflows/ci.yml` runs on main pushes, pull requests, manual dispatch,
and reusable-workflow calls. Its matrix is Ubuntu24.04/Windows2025 with
Node22.13.0/24.22.1. Each job installs the lockfile, runs `npm run verify`, and
retains declaration evidence. Verification includes build, all tests, minimum
TypeScript/500-node cases, pack-list checking and a real installed tarball consumer.
Jobs use separate workspaces; no build and pack processes share an output tree.

Actions are pinned to reviewed official commits. Upgrade those references and
the selected Node versions together with local validation. Local checks do not
prove a GitHub-hosted run; inspect the Actions result after pushing this workflow.

## Prepare a candidate

Before creating a release tag:

1. Obtain the owner's version and license decision. Add the approved SPDX license
   field and complete LICENSE text. Automated checks establish presence, not legal
   correctness or full SPDX expression validity.
2. Set the approved version in package.json and both lockfile root locations.
   Keep the package name, exports, runtime dependencies and engine contract aligned.
   Run `npm run build` and `npm run update:goldens` before verification: the compiler
   version is part of the fixed generated headers. Review those artifact and
   manifest changes together; do not weaken the fixed-byte golden tests.
3. Set `private:false` explicitly. The general package checker supports both
   development and release metadata; publishing preflight accepts only false.
4. Move release notes from Unreleased to `## VERSION` or `## [VERSION]` in
   CHANGELOG.md. Package repository/public-registry metadata is already supplied.
5. Run `npm run verify` and `npm run release:check -- --tag vVERSION`.
   Release versions use SemVer without `+build` metadata. Prereleases publish to
   `next`; stable versions to `latest`. Confirm the selected version is available
   with `npm view @devcodex/flowkit versions --json` before approving publication.
6. Commit the approved candidate. Obtain authorization to push the tag; pushing a
   matching `v*` tag activates the publishing workflow.

The check is read-only and reports every metadata gap as JSON. Exit0 means ready,
exit1 means not ready, exit2 means invalid invocation, I/O or artifact failure.
`compileSource` and the product CLI are unrelated to these maintainer commands.

## Publish

Configure npm Trusted Publisher for organization `devcodex-labs`, repository
`flowkit`, workflow filename `publish.yml`. Use a GitHub-hosted runner. For newer
publisher configurations, enable direct `npm publish` as an allowed action.
Create the publisher configuration close to the authorized release: npm requires
its first successful publish within 2 days. An expired configuration must be
deleted and recreated by the account owner before another attempt.
This guide does not change account/repository settings or require an AI to read
credentials. npm requires Node>=22.14.0 and npm>=11.5.1 for trusted publishing;
the publish job uses Node24.22.1 and npm11.5.1. OIDC provenance is generated
automatically for public repository/public package combinations; it is not proof
that this repository's publisher setup has already been tested.

After the authorized tag push, `publish.yml` performs preflight, calls the same
four-environment CI, builds and packs once, uploads the tarball and source-byte
manifest, then downloads and verifies that exact artifact before publishing it.
Only the final job receives `id-token:write`. The workflow publishes the `.tgz`
it verified rather than packing another candidate in the publish step.

To inspect a prepared artifact locally after build:

```sh
npm run release:pack -- --tag vVERSION
node scripts/release.mjs verify --tag vVERSION
npm publish .tmp/release/*.tgz --dry-run --access public --registry=https://registry.npmjs.org/
```

The maintainer script never invokes actual npm publish. `.tmp/release` contains
one tarball and `release.json`; verification checks tag/version, full tarball hash,
the exact package member set and source hashes without rebuilding. The pack
operation reuses an existing artifact only when those checks still pass.
Verification parses the actual gzip/tar contents in memory, rejects duplicate,
linked, missing or unexpected members, and compares their content to the checked-out
sources. Limits are 4MiB compressed and 16MiB expanded; no paths are extracted.

## Failures and recovery

- An unready private snapshot is expected to stop preflight. Resolve the reported
  metadata gaps; do not remove checks to make a development package publish.
- A tag mismatch stops the chain before CI/publication. Fix the candidate/tag
  decision; never silently publish a different version under the same tag.
- A partial pack or unrelated files in `.tmp/release` are refused. Inspect the
  directory, preserve any required evidence, then clear only those owned release
  outputs before packing again. The script never deletes an unrelated directory.
- A changed source or tarball hash requires a fresh candidate and fresh verification.
  Do not regenerate a manifest to bless an unexplained artifact.
- npm versions cannot be overwritten. If a publish response is interrupted or
  uncertain, first query that exact version and its integrity on npm; do not
  blindly retry, delete the version or move dist-tags. A correction normally uses
  an explicitly approved new version.
- CI failures retain their command output and declaration artifact when available.
  The dependency cache is not node_modules; clean installs remain lockfile based.

Official references: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[GitHub Node package publishing](https://docs.github.com/en/actions/how-tos/use-cases-and-examples/publishing-packages/publishing-nodejs-packages).
