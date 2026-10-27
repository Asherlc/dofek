# Task 4: Process App Store Server Notifications V2

## Status

Complete. The server now accepts App Store Server Notifications V2 at `POST /api/webhooks/app-store`, verifies the signed notification and its nested subscription data before writing, and applies each notification UUID at most once.

## Implementation

- Added an Express raw-body webhook route with a strict `{ signedPayload }` request schema. Malformed, extra-field, and definitively invalid signed payloads return HTTP 400 without persistence.
- Added App Store Server Library verification for the outer notification JWS and nested transaction and renewal JWS values. Verified subscription state is normalized through the existing App Store subscription model.
- Added atomic repository processing: the global `fitness.app_store_notification` UUID ledger is inserted in the same database transaction as the subscription-state update. A valid duplicate returns success without applying state again.
- Added support for Apple's signed `TEST` notification type, which records the UUID without requiring subscription data or changing billing state.
- Mounted the route before general JSON middleware and routed unexpected failures to the shared Express/Sentry error handler.
- Classified the notification ledger as shared system data in account erasure. It has no user ownership, foreign key, or deletion path.
- No mobile files or provider inventory were changed.

## TDD Evidence

Tests were introduced before their implementations and observed failing for the expected missing behaviors: the absent webhook route, notification verifier, exact server mount, repository operation, and erasure classification. Additional red cases exposed incorrect handling of unexpected and retryable verifier errors and Apple's `TEST` notification; each was fixed before moving on.

Coverage added for:

- outer and nested JWS verification;
- active, grace-period, revoked, expired, malformed, mismatched-account, retryable, and test notifications;
- raw request parsing and strict request shape;
- no-write behavior for invalid input;
- duplicate UUID idempotency;
- unexpected persistence failure delegation to the shared error handler;
- real Postgres atomic ledger and subscription-state behavior;
- the exact public webhook route.

## Verification

- `pnpm test -- --run`: 1,144 files passed, 2 skipped; 16,712 tests passed, 21 skipped.
- `pnpm typecheck`: no TypeScript errors.
- `pnpm lint`: completed successfully, including Biome, repository policy checks, mobile route checks, dbt compilation, and SQLFluff.
- `pnpm test:integration -- packages/server/src/repositories/billing-repository.integration.test.ts`: 1 file passed; 8 tests passed against the workspace Postgres service.
- `pnpm test:integration -- src/db/migrate.integration.test.ts`: 1 file passed; 20 schema and account-erasure policy tests passed.
- `git diff --check`: clean.

## Remaining Concern

Local tests exercise the Apple library behind controlled verifier doubles and the persistence path against real Postgres. A live Apple sandbox signed notification, certificate-chain validation, and delivery retry should still be exercised during the planned end-to-end App Store sandbox validation.

## Retrospective

The existing subscription normalization and repository boundary made the implementation focused, while atomic idempotency and Apple `TEST` notifications required the most investigation. The task brief and package guidance were sufficient; a reusable checked-in App Store Server Library fixture or sandbox-notification runbook would make future notification work faster and provide stronger certificate-path regression coverage. For similar work, use the repository's TDD, verification-before-completion, and integration-tests-ready workflows.
