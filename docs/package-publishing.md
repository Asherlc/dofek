# Package publishing

Dofek publishes reusable TypeScript packages from this monorepo and mirrors
native packages into dedicated SwiftPM repositories. Both release paths run
only after the `CI` workflow succeeds for the current `main` commit.

## npm architecture

pnpm remains the workspace and publishing package manager. Lerna 9 is used only
for the part pnpm does not provide: detecting changed release packages,
independently patch-versioning them, updating workspace dependency versions,
and creating release commits and tags. Lerna recommends letting the package
manager own workspace installation and supports independent versions
([Lerna workspace guidance](https://lerna.js.org/docs/getting-started#adding-lerna-to-an-existing-repo),
[version and publish](https://lerna.js.org/docs/features/version-and-publish)).
pnpm rewrites supported `publishConfig` fields when packing, which lets local
workspace exports resolve TypeScript source while npm tarballs export compiled
JavaScript and declarations
([pnpm `publishConfig`](https://pnpm.io/package_json#publishconfig)).

The automatic path is:

1. `.github/workflows/version-npm.yml` receives a successful `CI`
   `workflow_run` for `main`.
2. The workflow mints a short-lived GitHub App installation token, verifies
   that the tested commit is still current, and skips when any package version
   is still untagged (a release already in flight).
3. `lerna version patch --yes --no-git-tag-version --no-push` independently
   patch-bumps only changed packages and updates internal package references
   without creating a local version commit or tag. The workflow stages and
   commits those changes, then pushes the resulting commit on a `release/npm-*`
   branch; it opens a squash pull request and enables auto-merge so required
   checks run before the bump lands on `main`. Tags are not created here, so an
   abandoned pull request or a stale remote tag cannot block version-PR
   preparation.
4. After the version pull request merges and `CI` succeeds again,
   `.github/workflows/release-npm.yml` builds every package in `lerna.json`,
   runs the public-package unit suite, and publishes with
   `pnpm --recursive publish`. Private application workspaces are skipped.
5. npm authenticates the publish job with a short-lived GitHub OIDC credential
   and automatically records provenance. No npm write token is stored in
   GitHub. After a successful publish, the workflow creates and pushes only the
   `<name>@<version>` tags for packages that were not already tagged.

npm requires Node 22.14 or newer, npm 11.5.1 or newer, `id-token: write`, a
GitHub-hosted runner, and an exact trusted-publisher workflow filename. It also
requires a package to exist before its trusted publisher can be configured
([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)).

A failed registry upload is recoverable with `workflow_dispatch` on
`release-npm.yml`: pnpm publishes workspace versions that are not yet in the
registry, and the tagging step is a no-op for versions already tagged.

### Adding another npm package

A public package must:

- live in the pnpm workspace;
- have a unique scoped name, stable version, `license`, `repository`,
  `homepage`, `bugs`, `engines`, `files`, `exports`, and
  `"publishConfig": { "access": "public" }`;
- ship compiled JavaScript and declarations rather than TypeScript source;
- use source paths in the local `exports` map and compiled paths in
  `publishConfig.exports`;
- include standalone `README.md`, `LICENSE`, and agent-only `AGENTS.md`
  documentation, with `CLAUDE.md` and `GEMINI.md` symlinked to `AGENTS.md`;
- use `workspace:` references for other Dofek packages so pnpm and Lerna can
  maintain the local graph;
- be listed in `lerna.json` and the `release:npm:test` package paths; and
- pass a clean tarball installation before its first publication.

The first version must be published by an npm owner with 2FA because npm cannot
attach a trusted publisher to a package that does not yet exist. After that
one-time bootstrap, configure `Asherlc/dofek` and `release-npm.yml` as the
package's GitHub Actions trusted publisher. Subsequent releases require no
registry credential or maintainer action.

## SwiftPM architecture

`.github/workflows/release-swift-packages.yml` is shared by every native
package. `.github/swift-packages.json` supplies its dynamic job matrix. Each
entry declares:

- a stable package ID and display name;
- the canonical Swift package path in this repository;
- the public distribution repository (`<owner>/<repo>`); and
- a TypeScript exporter that accepts the checked-out mirror directory.

Write access to each distribution repository comes from a short-lived GitHub
App installation token minted by `actions/create-github-app-token`, scoped to
the owner and repository parsed from that entry's `repository` field. No
per-package token secret is stored in the configuration.

For each entry, the workflow:

1. tests the canonical package with `swift test` on a GitHub-hosted macOS
   runner;
2. mints an App installation token for the distribution repository owner and
   checks out that repository;
3. exports the canonical source while preserving the mirror's `.git`
   directory;
4. skips the release when the exported tree is unchanged; and
5. otherwise creates the next patch tag, atomically pushes the mirror commit
   and tag, and creates a GitHub release.

SwiftPM resolves package releases from semantic-version Git tags. Swift's
package release guidance recommends semantic versioning and creating a new tag
for each release
([Swift package releases](https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/releasingpublishingapackage/)).

The WHOOP BLE entry exports to
[`Asherlc/whoop-ble-swift`](https://github.com/Asherlc/whoop-ble-swift). Its
exporter intentionally omits the Expo bridge while retaining the standalone
`WhoopBLE` product, public facade, tests, license, README, and protocol
documentation.

### Adding another Swift package

Create or identify the public distribution repository, install the release
GitHub App on that repository (or its owner), add an exporter that follows the
`<target-directory>` contract, and add one entry to
`.github/swift-packages.json`. Do not create another release workflow. The App
installation must be able to push commits and tags and create releases in the
distribution repository.
