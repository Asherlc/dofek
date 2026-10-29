# OTA server upgrade implementation plan

Execute each task with regression tests before implementation and obtain an independent review before deployment. Record commands, results, image digests, snapshot identifiers and workflow run links in the [production incident record](../../production-incident-baseline.md).

**Goal:** Upgrade the OTA server/publisher to 3.2.7, propagate storage failures,
and migrate production with a verified backup and rehearsed restore path.

**Architecture:** Build the official 3.2.7 source at immutable commit
`071f6d907527d7de1ba21dd0be23a6ba669a2b1c`, adding only metadata-error propagation
and executable regression coverage. Prepare the image and durable backup tooling
before changing production's image; then rehearse and perform the canonical
cutover. Keep PR 3148's client gate unmerged until the server change is ready.

**Tech Stack:** Go 1.27.3, Docker, Terraform, R2, rclone 1.75.2, TypeScript,
GitHub Actions, existing Infisical OIDC.

**Spec:** [Approved upgrade requirements](../specs/2026-10-29-ota-server-upgrade.md).

## Global constraints

- Server/publisher 3.2.7; preserve current signing keys and installed-client URLs.
- No retries, longer readiness deadlines, suppressed errors, or runtime workarounds.
- No destructive production migration before byte-verified backup and isolated rehearsal.
- All repository automation scripts are TypeScript; use established transfer tooling.
- Use Terraform and canonical deployment workflows for production mutations.
- Keep the native WHOOP upload independent; verify its Apple processing result.

## Review focus

- A storage permission/network failure must not become a successful empty runtime.
- An incomplete upload or absent marker must remain distinguishable from storage failure.
- Rehearsal must not write, delete, or lock production keys or shared caches.
- Copy/delete migration must preserve manifest identity, asset bytes, and signatures.
- Old publishers must be paused until compatible 3.2.7 publication is available.

### Task 1: Build a corrected 3.2.7 server image

**Files:** `deploy/ota/Dockerfile`, `deploy/ota/upstream.patch`,
`deploy/ota/README.md`, local agent guidance and symlinks;
`.github/workflows/build-ota.yml`, `.github/workflows/ci.yml`, and the existing
change-detection source and colocated test.

**Interfaces:** Official source revision above; an immutable GHCR image digest
containing the official dashboard and corrected binary. The workflow must fail
on source, patch, test, or image-build errors.

- [ ] Add upstream tests for marker and metadata read faults, missing/incomplete
  updates, valid updates, and real HTTP 500 propagation. Run the tests before
  changing production code; record the metadata regression failing.
- [ ] Propagate unexpected stored-metadata read errors. Preserve missing-file and
  platform filtering semantics; do not redesign repository or cache behavior.
- [ ] Build with the latest stable pinned Go toolchain; retain official 3.2.7
  runtime/dashboard files and an auditable source/patch provenance.
- [ ] Test image selection through the existing executable change detector;
  wire image tests/build into CI and its final gate without adding config-string tests.
- [ ] Run focused upstream suites and image smoke checks, then commit and push.
  Obtain a fresh review before production use.

### Task 2: Prepare verified storage backup and rehearsal operations

**Files:** `deploy/storage.tf`, `.github/workflows/ota-storage.yml`,
`scripts/ota-storage.ts`, `scripts/ota-storage.test.ts`, `deploy/ota/README.md`.

**Interfaces:** A Terraform-managed `dofek-ota-backups` bucket, disjoint immutable
snapshot and mutable rehearsal prefixes, existing Infisical R2 credentials,
and the Task 1 image digest. Use rclone copy/check rather than a custom copier.

- [ ] Add failing public-CLI tests for unsafe snapshot identifiers, failed copy
  or verification, unexpected active publishers, and command isolation. Fail
  before any migration when a prerequisite fails.
- [ ] Implement the minimal TypeScript orchestration of pinned transfer tooling;
  validate external JSON with Zod and never print credentials.
- [ ] Define immutable snapshot, verified rehearsal copy, and explicit restore
  operations. Use BUCKET_KEY_PREFIX and local cache for rehearsal.
- [ ] Add the durable backup bucket and a manual operator workflow, using
  existing credentials and explicit publication pause/resume procedures.
- [ ] Merge the preparation changes only after CI/review. Keep the old server
  and old gate in production at this preparation checkpoint; publish no
  compatibility layer or temporary runtime behavior.
- [ ] Provision through Terraform, snapshot and byte-verify production, rehearse
  migration and restore against the copy, and record exact evidence and digest.

### Task 3: Cut over server and publisher, then restore the corrected gate

**Files:** `deploy/stack.yml`, all existing EOAS publisher workflows,
`scripts/check-ota-manifest.ts` and its test, deployment/runbook documentation,
`docs/production-incident-baseline.md`.

**Interfaces:** Task 1 image digest and Task 2 verified snapshot/rehearsal record.
Publisher 3.2.7 must use app-scoped routes; clients keep their existing keys/URLs.
The preparation restore operation targets only the rehearsal copy. It is not a
production rollback tool; production migration is blocked until the following
production recovery gate is implemented and validated.

- [ ] **Blocking recovery gate:** Implement and test an executable main-only
  production restore operation before changing production's server image.
  Require publishers to be paused, actual OTA tasks to be quiesced through the
  canonical deployment workflow, and a verified immutable snapshot. Refuse
  writes while any OTA task can run. Restore the snapshot to the production
  bucket with [rclone sync](https://rclone.org/commands/rclone_sync/), then
  [byte-verify it](https://rclone.org/commands/rclone_check/) before deploying the
  old image. Test destination selection, active-task refusal and failed copy/
  verification paths; retain the existing rehearsal restore regression.

- [ ] Update all publisher invocations to the matching 3.2.7 package and remove
  obsolete version comments. Pin production to the validated image digest.
- [ ] Verify genuine empty-runtime directives, correct-runtime manifests,
  signatures and asset hashes; inject metadata/marker faults and require HTTP 500.
- [ ] Restore the already-tested runtime/protocol gate correction only with the
  server fix. Run required local checks and obtain whole-branch review.
- [ ] Confirm publisher pause and verified snapshot are current, then deploy
  through the canonical workflow. Observe migration completion and validate
  manifest identity/signatures/assets before resuming publication.
- [ ] Publish via EOAS 3.2.7 and verify the public update. If migration fails,
  keep publishers paused, quiesce OTA through the canonical workflow, and use
  the separately validated production restore operation above. Verify restored
  bytes before deploying the old server/publisher release unit; image rollback
  alone never restores data. The rehearsal-only command cannot perform this
  recovery.
- [ ] Update incident evidence and close PR review threads with code and
  validation links. Report remaining physical WHOOP validation explicitly.

## Execution notes

The operator explicitly chose the upgrade/migration rather than deferring the
server finding or keeping a patched 2.x deployment. Continue inline on the
approved `fix/ota-release-runtime` branch; do not switch branches or rebase.
Staging may require preparation and cutover PRs so backup tooling is callable
before destructive migration. Source and signing-key verification must precede
production cutover; exact operational evidence belongs in the ledger/runbook.
