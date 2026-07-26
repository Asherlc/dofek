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

1. `.github/workflows/release-npm.yml` receives a successful `CI`
   `workflow_run` for `main`.
2. The workflow verifies that the tested commit is still current, builds every
   package in `lerna.json`, and runs the public-package unit suite.
3. `lerna version patch --yes` independently patch-bumps only changed packages,
   updates internal package references, creates a release commit, tags each
   package as `<name>@<version>`, and pushes the release commit and tags.
4. `pnpm --recursive publish` publishes workspace versions that are not yet in
   the registry. Private application workspaces are skipped.
5. npm authenticates the workflow with a short-lived GitHub OIDC credential and
   automatically records provenance. No npm write token is stored in GitHub.

npm requires Node 22.14 or newer, npm 11.5.1 or newer, `id-token: write`, a
GitHub-hosted runner, and an exact trusted-publisher workflow filename. It also
requires a package to exist before its trusted publisher can be configured
([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)).

The workflow recognizes a tagged release commit whose parent is the tested
commit. This makes a failed registry upload recoverable with
`workflow_dispatch`: pnpm can publish the versions already tagged at `HEAD`
without creating another version.

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
- the public distribution repository;
- a TypeScript exporter that accepts the checked-out mirror directory; and
- the GitHub secret name used to write to the distribution repository.

For each entry, the workflow:

1. tests the canonical package with `swift test` on a GitHub-hosted macOS
   runner;
2. checks out the configured distribution repository;
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

Create or identify the public distribution repository, add an exporter that
follows the `<target-directory>` contract, and add one entry to
`.github/swift-packages.json`. Do not create another release workflow. The
configured GitHub token must be able to push commits and tags and create
releases in the distribution repository.
