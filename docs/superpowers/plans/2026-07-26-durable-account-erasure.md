# Durable Account Erasure Implementation Plan

**Goal:** Replace the misleading data-wipe control with a durable account-erasure workflow that revokes access immediately, physically erases Dofek-controlled data after the seven-day replay boundary, and publishes a truthful 30-day completion maximum.

**Architecture:** An authenticated initiation mutation creates a durable request and outbox record in the same transaction that revokes sessions and activates a database write fence. A single idempotent BullMQ coordinator advances persisted phase checkpoints for remote revocation, processor cleanup, queue/file/object cleanup, Postgres deletion, ClickHouse mutation, mixed-user R2 archive rewriting, replay-window verification, and final pseudonymization. Public status uses an opaque bearer token so progress remains available after session revocation. Web and mobile use the same API contract and purge local Dofek-controlled stores on initiation.

**Tech Stack:** TypeScript, Drizzle/Postgres, BullMQ/Redis, ClickHouse, AWS S3 client/R2, Stripe, tRPC, React, React Native, Vitest, MSW, Cypress, Terraform

## Approved Product Contract

- Require explicit typed confirmation and a current authenticated session.
- Revoke all sessions and block login, session creation, syncs, webhooks, uploads, companion writes, and queued writes immediately.
- Cancel active Stripe subscriptions and delete the Stripe customer at initiation.
- Retry provider/webhook/Apple revocation durably before discarding credentials.
- Keep a pseudonymous restore ledger while removing the live user identifier at completion.
- Do not report completion until the seven-day Redpanda replay window has elapsed and a second ClickHouse/R2 sweep verifies absence.
- Publish a 30-day maximum completion window and accurately disclose processor, log, backup, and OS-owned data boundaries.
- Keep Dofek-written HealthKit nutrition removal as an explicit client cleanup step; never claim deletion of OS-owned HealthKit/CoreMotion source data.

## Implementation Tasks

- [ ] Add the account-erasure schema, migration, write fence, status-token hashing, outbox, checkpoints, exercise provenance, and 21-day backup lifecycle.
- [ ] Write failing Postgres tests for atomic initiation, session revocation, login/write fencing, exhaustive direct/indirect ownership, and final pseudonymization.
- [ ] Add the account-erasure repository, public status query, protected initiation mutation, and authentication fence.
- [ ] Write failing coordinator tests for phase order, retry/resume, seven-day wait, error persistence, and completion verification.
- [ ] Add the account-erasure BullMQ queue, outbox dispatcher, worker, and idempotent phase coordinator.
- [ ] Add durable provider/webhook/Apple and Stripe revocation adapters with network-level tests.
- [ ] Add BullMQ/Redis, persistent job-file, import/export object, and PeerDB propagation cleanup with exact-target tests.
- [ ] Add ClickHouse logical fences, direct/indirect physical mutations, safe orphan-dbt cleanup, mutation waiting, and real ClickHouse tests.
- [ ] Add checkpointed R2 gzip archive streaming rewrites with conditional writes and fixture tests.
- [ ] Add web and mobile initiation/status controls plus browser/mobile/watch/native local-store purge tests and stories.
- [ ] Add `/account-deletion`, landing/privacy copy, processor/backup/restore runbooks, and request-to-completion E2E coverage.
- [ ] Run targeted unit/integration/UI checks, lint, typecheck, migration validation, Terraform plan/apply, and branch-wide changed tests.
- [ ] Commit, push, open a PR with `Fixes #1994`, move the issue to In Review, monitor CI, address review feedback, and hand the passing PR to the parent agent for merge.

## Source References

- Apple account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app
- Google Play account deletion: https://support.google.com/googleplay/android-developer/answer/13327111
- GDPR Article 17: https://eur-lex.europa.eu/eli/reg/2016/679/art_17/oj/eng
- Cloudflare R2 conditional S3 writes: https://developers.cloudflare.com/r2/api/s3/api/
- Cloudflare R2 lifecycle rules: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Stripe customer deletion: https://docs.stripe.com/api/customers/delete
