# Immutable deployment image implementation plan

**Goal:** Deploy exactly the application image verified at release selection,
even when the requested registry tag moves during deployment.

**Architecture:** Resolve the requested image to a registry digest once, then
validate the baked full source SHA using that immutable reference. Preserve the
existing desired web image digest for the pre-migration stack apply. All later
application operations use the newly verified digest. Docker documents digest
references as immutable identifiers in its [image pull reference](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier).

**Scope:** This is the deployment correction approved during climbing GPS
backfill review in [PR #2960](https://github.com/Asherlc/dofek/pull/2960#discussion_r4285095832).

**Constraints:** Retain the existing release selection, backup checks, schema
migrations, CDC gates, rollback handling, and service stability windows. Do not
modify Dockerfiles, entrypoints, Terraform resources, secrets, or retry policy.

## Task 1: Resolve and validate the release once

Files: `scripts/resolve-deploy-image.ts`, its colocated unit and integration
tests, and `scripts/README.md`.

Interface: `pnpm tsx scripts/resolve-deploy-image.ts <requested-image-reference>
<expected-full-source-sha> <web-service-name>` writes `image_ref`,
`pre_migration_image_ref`, and `sentry_release` to `GITHUB_OUTPUT`.

- [x] Write and run failing executable cases for a moving tag, a mismatched
  baked source SHA, an absent initial web service, a present service with an
  immutable desired reference, and Docker inspection failure.
- [x] Resolve the registry descriptor once, pull and inspect by digest, check
  the full source SHA, and preserve the existing desired image digest.
- [x] Verify resolver behavior against an actual Docker engine and a controlled
  registry whose tag changes after resolution. Mock only Swarm service lookup
  where the local engine has no Swarm; do not substitute mocked image behavior
  for this integration proof.

## Task 2: Carry the verified reference through the deployment

Files: `.github/workflows/deploy-web-stack.yml`, `deploy/stack.yml`, and
`deploy/README.md`.

- [x] Execute the workflow image-selection block with controlled CLI fixtures
  and observe the current tag-based behavior fail the digest contract.
- [x] Replace application tag reconstruction with the required, workflow-derived
  `APP_IMAGE` reference across stack applies and one-shot application containers,
  covering all eight application services after YAML anchors expand.
- [x] Retain the prior digest before migrations; use the selected new digest
  afterward. Ensure dotenv loading cannot replace the selected reference.
- [x] Require application convergence to match the selected immutable reference,
  while retaining the existing web rollback branch and other safety gates.
- [x] Run workflow schema checks, stack rendering, relevant unit/integration
  tests, lint, and root/server/web typechecks. Independently review the complete
  task before committing and pushing it with the sync-ordering correction.

## Review checkpoints

Review tag movement between every phase, initial deployment, failed Docker
inspection, image/source mismatch, dotenv precedence, multi-platform digest
identity, and rollback to the previous application. After the canonical release,
verify the actual Swarm desired and running application images against the
validated reference; local fixtures alone do not establish production rollout.
