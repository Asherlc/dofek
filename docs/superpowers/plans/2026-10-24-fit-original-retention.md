# Original FIT Retention Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans; tests first and explicit independent review checkpoints.

**Goal:** Durably retain every received, extractable original FIT before parsing across all current input paths.

**Architecture:** Extend the existing artifact storage with local-file retention and an owned-presence query. The shared FIT importer awaits retention; official Garmin supplies its existing owned artifact reference. Existing provider/account erasure remains the canonical deletion path.

**Tech Stack:** TypeScript, existing AWS S3 SDK/R2, Garmin native decoder, Vitest/MSW/Postgres.

**Spec:** `docs/superpowers/specs/2026-10-24-fit-original-retention-design.md`

## Global Constraints

- Stay on `flawless-shark`; root commits and pushes automatically.
- Add no dependencies, environment variables or lifecycle/configuration changes.
- Retain bytes before decode, including malformed and unsupported FITs; do not swallow storage errors.
- Keep archival work bounded through streamed hashing/upload; preserve `originalPath`, external IDs and source labels.
- Reuse official Garmin's owned object; never trust another user's/provider's retained key.
- No new UI or extraction features; provider deletion serves both clients.

## Review Focus

- Same filename with different bytes must retain both originals; retries of identical bytes reuse one key.
- An archive failure must prevent decode and successful cleanup.
- Invalid FITs and FITs with invalid companion summaries must not disappear.
- A foreign retained key must fail before archive access or decode.
- Archives without canonical records must remain erasable through their owned provider boundary.
- Outer provider/ZIP cleanup must preserve an owned, usable retry source when archive writes fail.
- Upload/dump archive writes must share provider-deletion exclusion so a concurrent PUT cannot recreate data after erasure completes.

### Task 1: Artifact storage

**Files:** `src/provider-artifact-storage.ts`, colocated unit/integration tests; typed artifact-storage stubs in existing tests.

**Produces:** Required `ProviderArtifactStorage.retainFile(input: {userId:string; providerId:string; filePath:string; retainedObjectKey?:string}): Promise<string>` and `hasForProvider(userId:string, providerId:string): Promise<boolean>`.

- [x] Write failing byte-identity, bounded stream, owned-key reuse/rejection, archive failure and presence tests; observe RED.
- [x] Implement streamed content hashing plus existing `ensureArtifact`; validate explicit retained key against exact owned prefix. Implement bounded `ListObjectsV2` presence using `MaxKeys: 1` and validate returned ownership.
- [x] Verify GREEN, update typed stubs and self-review; obtain independent review.

### Task 2: Shared FIT import and ZIP routing

**Files:** `src/jobs/process-fit-file-import-job.ts` and tests, `src/providers/garmin/activities.ts` and tests, `src/providers/garmin-dump.ts` and tests, necessary caller test fixtures.

**Consumes:** Task 1 `retainFile`. **Produces:** `importFitFile` accepts `retainedArtifactKey?:string` on its resolved local data and a final `ProviderArtifactStorage` dependency defaulting to the existing environment factory.

- [x] Write failing ordering/failure/identity tests and invalid-summary ZIP-routing test; observe RED.
- [x] Await retention before decoder/spool startup; preserve all identity inputs. Garmin passes its existing key and storage. Remove the invalid-summary FIT skip while keeping its summary error.
- [x] Verify archive survives source cleanup with real S3/native integration, focused import/provider suites, typecheck and self-review; obtain independent review.

### Task 3: Archive-only provider erasure

**Files:** server provider detail repository and its unit/integration tests; storage network test helpers if needed.

**Consumes:** Task 1 `hasForProvider`. **Produces:** Existing `canDeleteProviderData` additionally recognizes artifacts owned by the exact user/provider after canonical ownership checks.

- [x] Write failing retained-only ownership test with foreign user/provider isolation; observe RED.
- [x] Use the existing artifact-storage environment factory at the actual archive ownership check, preserve canonical checks and error propagation.
- [x] Verify focused unit and executable ownership integration suites; obtain independent review.

### Task 4: Integration and completion

- [x] Review full change, fix material findings with regression tests.
- [x] Run focused affected unit/integration suites, root/server typechecks, repository lint and diff checks.
- [x] Replace the retention matrix with the new policy and recovery/deletion limits; cite sources and record a brief retrospective.
- [x] Commit and push on the existing branch; verify local/remote heads and clean working tree.

## Review follow-up

Initial focused checks passed (655 unit tests,25integration tests,typechecks and lint), but full-source review found lifecycle gaps beyond the shared importer. Before completion, add outer staging/ZIP archive-failure coverage and executable concurrent upload/deletion coverage, preserve the existing owned work/deletion machinery, then re-review both findings and rerun affected checks.

- [x] Synchronize FIT/manual/dump outer workers and CLI with provider deletion using existing guards; validate queued/upload owner and import-type agreement; prove active PUT/deletion exclusion with real Postgres locks.
- [x] Keep provider pending sources under an owned deterministic staging prefix with exact import metadata; archive before inline/queued processing, and clean only after retention succeeds. Include pending-prefix removal in provider/account erasure.
- [x] Persist queued FIT retention state before decoding, propagate unretained child failures without ZIP/upload cleanup, and retain usable owned retry inputs. Treat logical original paths as provenance rather than filesystem cleanup targets.
- [x] Re-review the combined fix and rerun the amended source-lifecycle suites and final checks.

Final verification: 717 unit tests in22affected/boundary files and39integration tests in7files passed. Root/server typechecks, repository sandbox lint and whitespace checks passed. Independent scoped re-review marked both original findings addressed and approved the full feature. No production deployment or historical reimport was performed.

## Retrospective

Reusing the existing R2 store and erasure boundaries avoided new infrastructure. Whole-flow review was necessary: inner import tests alone missed outer cleanup and provider-deletion exclusion, and a wrapper-only mock missed manual-source unlinking. Regression coverage now follows the original bytes through actual filesystem staging, native decoding, Redis child/batch/parent state, and real Postgres deletion locks.

Useful context next time: `originalPath` is identity-bearing logical provenance, pending provider copies are disk-backed sources with exact recovery metadata, and ZIP parent retries do not automatically recover failed children. Proposed testing-guide update: require retention reviews to trace every outer cleanup owner and the concurrent erasure boundary. Use test-driven-development and integration-tests-ready for similar changes.
