# Fail Review Seeding on Migration Errors TDD Plan

**Goal:** Prevent the review-data seeder from reporting success after a real migration failure.

**Behavior:** Migration statements either succeed through the canonical migration path or abort seeding with the original file, statement, and database error; unrelated SQL failures are never treated as duplicate-object reruns.

**Scope:** Fix migration execution in `scripts/seed-dev-db.ts` and add focused tests. Do not redesign the seed dataset.

**Docs:** [`scripts/README.md`](../../../scripts/README.md), [`docs/testing.md`](../../testing.md)

---

## Current Evidence

- `applyMigrations()` wraps every `sql.unsafe(statement)` in an empty `catch` whose comment says only duplicate-object errors are ignored.
- It increments the applied-file count after swallowed failures and can continue into seeding with a partial schema.
- No test exercises `applyMigrations()` or proves non-duplicate errors stop the script.

Primary sources: the current [`seed-dev-db.ts`](../../../scripts/seed-dev-db.ts)
and PostgreSQL's definition that an erroneous statement aborts the current
transaction in [`ROLLBACK`](https://www.postgresql.org/docs/current/sql-rollback.html).

## Test Strategy

- Unit: extract a production-owned migration runner that accepts a required statement executor. Inject a stub executor that rejects one statement, then assert the runner stops and preserves the exact migration filename, failed SQL statement, and original database error as its cause.
- Integration: extend the existing `src/db/seed-dev-db.integration.test.ts` subprocess suite with a disposable database state that makes a known tracked migration fail. Assert the real seeder exits non-zero, reports the exact filename, statement, and original database error, and writes no seed rows. Keep the suite's existing fresh-schema success and idempotency coverage rather than duplicating it in a script unit test.
- UI/mobile/web parity: not applicable; both review clients depend on the same seed database.

## File Structure

- Modify: `scripts/seed-dev-db.ts` - construct and call the migration runner with `sql.unsafe` as the required statement executor.
- Create: `scripts/seed/migration-runner.ts` - own migration-file execution and contextual error propagation through the injected executor; its exported API is consumed by the production seeder.
- Create: `scripts/seed/migration-runner.test.ts` - cover failure propagation through that production API with a stub executor.
- Modify: `src/db/seed-dev-db.integration.test.ts` - cover the real subprocess failure path while retaining its existing fresh-schema success and idempotency test.

## Tasks

### Task 1: Add Failing Tests

- [ ] Write a failing `migration-runner.test.ts` unit test whose injected executor rejects a known statement; assert the exact migration filename, failed SQL statement, and original database error cause are preserved and no later statement executes.
- [ ] Extend `src/db/seed-dev-db.integration.test.ts` with a real seeder subprocess failure test; assert a non-zero exit, the exact filename, statement, and database error context, and no seed rows after failure.
- [ ] Run `rtk pnpm vitest run --project unit scripts/seed/migration-runner.test.ts` and the focused integration suite.
- [ ] Confirm the failure is specifically the missing propagation.

### Task 2: Implement the Minimal Fix

- [ ] Route schema setup through the canonical migration mechanism or propagate all unexpected SQL errors with migration-file context.
- [ ] Keep reruns deterministic without broad catch-and-continue behavior.
- [ ] Run the focused test.

### Task 3: Final Verification

- [ ] Run the seeder against a fresh disposable Postgres database and verify migrations plus seed validation succeed.
- [ ] Run `rtk pnpm lint`, `rtk pnpm typecheck`, and the focused tests.
- [ ] Confirm the real subprocess stops immediately with a non-zero status and reports its exact migration filename, failed statement, and original database error.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete documentation or skill improvement.
