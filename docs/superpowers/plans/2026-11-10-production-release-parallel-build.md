# Production Release Parallel Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Name the automatic workflow Release Production and build the signed iOS archive alongside the server rollout, gating publication on a matching successful rollout.

**Architecture:** Extract the existing native-change check and signed archive jobs into `build-ios-release.yml`, returning artifact ID, source SHA and build number through reusable-workflow outputs. `deploy-ios.yml` retains serialized upload and receipt finalization, accepting that artifact and checking its source against the server's verified output. Build detection reads the last successful receipt without taking the publication lock; unresolved-intent rejection remains inside the serialized uploader. The automatic caller starts build and server independently; the manual Deploy caller retains server-first source resolution for arbitrary image tags.

**Tech Stack:** Existing GitHub Actions reusable workflows, artifacts, actionlint and Vitest; no additional dependencies or custom orchestration. GitHub documents [job dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds) and [reusable workflow outputs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-outputs-from-a-reusable-workflow).

**Spec:** The user approved the proposed rename plus parallel signed build, with TestFlight and OTA publication gated on the matching successful server rollout (“y”). The user also approved read-only build detection skipping unresolved intents while keeping publication strict (“y”) after review found pending-job replacement. This records the approved short design.

## Global Constraints

- Remain in the current isolated worktree and branch.
- Preserve exact-current-main successful push-CI eligibility and all server deployment gates and locks.
- Preserve native-change detection, human-forced builds, artifact-ID handoff, upload serialization and receipt recovery.
- Server failure, missing archive or source mismatch must prevent TestFlight publication.
- OTA remains dependent only on successful server rollout.
- Use runtime shell tests for the changed source-validation behavior; do not add static configuration tests.
- Do not merge or dispatch production. Push new commits automatically.

## Review Focus

- Superseded, failed or non-push CI cannot start the automatic signed build.
- Native-change skips and archive failures cannot attempt an upload.
- Artifact source must equal the server image's verified full source SHA before upload setup.
- Reruns use the selected artifact ID and preserve successful-upload receipt recovery.
- Mobile work does not retain the server production lock; manual image-tag releases keep their verified source.

### Task 1: Split archive construction from gated publication

**Files:** `.github/workflows/deploy-web.yml`, `.github/workflows/build-ios-release.yml`, `.github/workflows/build-ios-release.test.ts`, `.github/workflows/deploy-ios.yml`, `.github/workflows/deploy-ios.test.ts`, `.github/workflows/deploy.yml`, `scripts/testflight-deployment.ts`, `scripts/testflight-deployment.test.ts`.

**Interfaces:** The builder returns `commit_sha`, `build_number`, `artifact_id`; the publisher consumes those plus the server's verified `commit_sha`. Only the publisher holds `deploy-ios` through receipt finalization; build detection uses successful history without taking either mobile or production locks.

- [x] Record baseline focused runtime tests and actionlint.
- [x] Move existing native-detection tests with their workflow and first write runtime source-gate tests: matching SHA succeeds; malformed SHA and mismatched SHA fail before upload.
- [x] Observe the new tests failing, then extract existing build jobs and wire both callers to the publisher without duplicating build/upload steps.
- [x] Add runtime regressions for detection across unresolved states, pagination and first/forced builds; observe nine failures before separating build history from strict upload admission.
- [x] Review the actual dependency graph, eligibility, skipped-build conditions, permissions and upload lock; run actionlint and focused runtime tests.

### Task 2: Documentation, verification and review

**Files:** `README.md`, `deploy/README.md`, `scripts/README.md`, `docs/production-incident-baseline.md`, this plan.

**Interfaces:** Active documentation names Release Production and distinguishes parallel build from gated publication.

- [x] Update active workflow names, job paths and release diagram with official citations; retain workflow filename so existing links/automation continue working.
- [x] Run workflow-download policy, typecheck, relevant runtime tests and appropriate Docker-free checks. Record actual results and limitations.
- [x] Obtain fresh Architect review of the complete diff and resolve important findings.
- [x] Commit and push the final changes; provide a reviewable PR if no existing PR is present.

## Working Notes

- Current branch: `split-ios-deploy-from-web-deploy`, already in a linked worktree. No branch change is needed.
- Review checkpoints: inspect Task 1's actual workflow diff before updating documentation, then obtain a fresh whole-change review before committing.
- Manual releases stay server-first because an arbitrary image tag's verified source is available only after server resolution; this preserves their existing behavior within the approved automatic-release change.
- Review checkpoint: speculative build detection must neither acquire publication concurrency nor reject an active publisher's pending intent. The publisher must retain its strict ambiguity check immediately before creating its upload intent.

- Validation: full Docker-free unit/mobile suite passed 24,325 tests (19 existing skips) across 1,468 files; root typecheck, lint:sandbox, canonical source spelling, actionlint including ShellCheck, scoped yamllint and diff whitespace checks passed. The seven new source-gate runtime tests were observed failing before implementation and passing afterward.

- Final review found a pending-queue replacement race: a speculative detector sharing deploy-ios can replace a ready publisher. The stock queue: max option solves replacement but latest upstream actionlint v1.7.12 rejects the key (confirmed by official release metadata and a local compatibility probe). No linter suppression, tool fork, production change or commit was made. The user approved changing native-build detection to read the last successful receipt while leaving strict unresolved-intent checks at publication; the shared detector lock was removed.

- Final fix pass: the Architect review's pending-publisher replacement finding is resolved by the user-approved separation of build detection and strict publication. All nine new regressions failed first and then passed; the final 118 focused tests and full 24,325-test unit/mobile suite pass. Final typecheck, sandbox lint, source spelling, actionlint/ShellCheck, YAML lint and whitespace checks pass. Production artifact transfer remains a first-merged-release check.
