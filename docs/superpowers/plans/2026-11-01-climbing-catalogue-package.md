# Climbing Catalogue Package Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with an independent final review.

**Goal:** Extract, polish, and publish `@dofek/climbing-catalogue` without Dofek dependencies.

**Architecture:** Independent contracts, matching, adapters, and native-first search;
Dofek owns application seeds, cache, jobs, credentials, and reporting.

**Tech Stack:** TypeScript, Zod, Fuse.js, Cheerio, Vitest, pnpm, npm.

**Spec:** `docs/superpowers/specs/2026-11-01-climbing-catalogue-package-design.md`

## Global Constraints

- No branch switching; use existing isolated `gifted-pelican` checkout.
- No Dofek package dependencies in the new library.
- Preserve matching decisions and source attribution for both clients.
- Push new commits automatically; publish only the requested package.

## Review Focus

- Seeds without app IDs must work; malformed seeds must fail before network calls.
- Native discovery must enrich queries without mutating recorded inputs.
- Conflicting and incomplete evidence must never become confident identity.
- Provider errors must propagate into Dofek's existing Sentry/cache handling.
- Packed exports must load without monorepo resolution or source files.

### Task 1: Extract contracts, matching, adapters, and search

**Files:** Create `packages/climbing-catalogue/{package.json,tsconfig.json,src/*}`;
move `src/climbing-catalogue-matching*`, provider catalogue readers/tests, and
Kaya tag decoding into that package. Retain application-specific training contracts.

**Interfaces:** Produces `CatalogueSeed`, `CatalogueSourceResult`, existing adapter
classes and matching helpers, and `ClimbingCatalogueSearch.search(seed)`.

- [x] Write public search tests using seeds without user/log IDs, native enrichment,
  incomplete/conflicting evidence, invalid inputs, and adapter error propagation.
- [x] Run the tests and confirm RED for the missing public API.
- [x] Move existing implementations/tests, remove Dofek imports, extract orchestration.
- [x] Run standalone tests and package build; expect all passing.
- [x] Review the public API against the approved boundary.

### Task 2: Integrate Dofek and release packaging

**Files:** Modify `src/climbing-catalogue.ts`, `src/climbing-catalogue-sources.ts`,
shared training catalogue contracts, affected imports, manifests, lockfile,
`lerna.json`, release-test command, and active docs. Add package README/license/guidance.

**Interfaces:** Consumes Task 1 API; app seed extends generic seed with user/log IDs.

- [x] Retain cache/service tests and source-composition tests as consumer coverage.
- [x] Replace service orchestration with package search; pass only climb facts.
- [x] Update both clients' shared contracts and every moved import/document link.
- [x] Run focused unit tests, typechecks, lint, full unit tier, and packed external import.
- [x] Independent review, address substantive findings, verify, commit, and push.

### Task 3: Publish and verify

- [x] Confirm package name/version and inspect packed contents.
- [x] Publish only `@dofek/climbing-catalogue` with authorized npm credentials.
- [x] Verify registry metadata and install/import the published artifact.
- [x] Report publication or the exact external blocker; include a short retrospective.

## Working notes

- User approved full extraction, public npm publication, and the package name.
- Existing checkout is isolated; branch remains `gifted-pelican`.
- Preflight npm authentication returned HTTP 401; package name returned HTTP 404.
- Review checkpoint: extraction API, then independent whole-change review.
- Extraction checkpoint: 452 standalone tests and independent package build pass.
- Integration checkpoint: 24,126 unit/mobile tests pass, 19 skipped; root, server,
  training, web, and mobile typechecks pass. Sandbox lint passes. The packed
  package installs externally and all nine public exports resolve.
- Independent review found moved spelling scopes and a training public-API
  release break. Moved the existing spelling rules (RED: 14 diagnostics; GREEN:
  zero); documented migrated exports and selected training 0.2.0. No compatibility
  aliases were added. Review otherwise confirmed preserved matching behavior.
- The package build was checked with TypeScript 7.0.2 as well as the existing
  workspace compiler. CI's single-version policy requires using the shared
  compiler, as training does, rather than declaring a second compiler version.
- Publication completed on 2026-11-02 after the user completed owner web login.
  npm accepted `@dofek/climbing-catalogue@0.1.0`; registry metadata matched the
  verified tarball checksum. A fresh registry installation loaded all nine
  exports and exercised matching/search without Dofek runtime dependencies.
  Configured and verified `Asherlc/dofek` / `release-npm.yml` as the npm trusted
  publisher. Interactive publication required preserving a PTY through the
  command proxy; the publishing runbook now records this operator procedure.
- Final checks: 579 focused consumer/library tests pass; configured spelling
  checks all 3,153 files successfully; changed-file Biome and diff checks pass.
- Retrospective: existing regression coverage made this extraction verifiable.
  Public API removals and moved spelling scopes needed explicit release review.
  Suggested runbook refinement: add a public-export migration and moved-tooling
  checklist to package extraction tasks. Use executing-plans and independent
  code review again for similar extractions.

## PR review follow-up

- PR 3198 confirms the package in Lerna's public release set and the existing
  release build/test/publish path. Review corrections are versioned 0.1.1 for
  automatic publication after merge; the bootstrapped 0.1.0 remains available.
- Three regressions were reproduced RED, then fixed: a native climb point must
  not replace recorded area ancestry during discovery; exported source results
  must reject candidate/provider attribution mismatches; malformed OpenBeta JSON
  must retain a provider-specific error message and original cause.
- All 537 focused library/consumer tests pass. The package builds, and root,
  training, and server typechecks pass. Full unit/mobile verification passes
  24,130 tests (19 skipped). A clean 0.1.1 tarball installation loads all nine
  exports and verifies source-attribution rejection.
- Review documentation now states nullable location identity fields, names the
  proxy in the bootstrap procedure, and labels the standalone OpenBeta adapter.
- CI identified the missing package include in the mutation-only test project.
  A direct Vitest listing reproduced zero geometry tests, then discovered them
  after the package include was added. Both local and CI mutation targets now
  include the package, while integration suites remain excluded.
- Geometry and search mutation runs now score 100%, with no surviving or
  uncovered mutants (24 and 55 killed, respectively). Import-time geometry
  schemas are reloaded in their tests, with explicit degree-boundary coverage.
- After the added mutation coverage, 544 focused library/consumer tests pass;
  the package's eight test files account for 463 tests. No production code was
  changed solely for mutation testing.
- Added the package to the image's manifest-copy, runtime-source, and root-link
  lists after E2E server startup proved it missing from the image workspace.
- A second review identified duplicate geometry schemas. Consolidated them in
  the standalone geometry module, migrated application/training imports, retained
  training's composed wall-angle API, and documented the removed training GPS
  module in the 0.2.0 migration notes. Its coordinate cases now live beside the
  canonical geometry implementation. No duplicate definitions or GPS facade remain.
- Pinned the npm source citation to the inspected CLI release and clarified the
  README's named-type exports without adding an unused tag-type export.
- Final full unit/mobile run after consolidation: 24,131 pass, 19 skipped;
  root/server/web/mobile typechecks, the training build, and sandbox lint pass.
  Canonical geometry still kills all 24 mutants. Hosted validation of the final
  cleanup remains pending.
