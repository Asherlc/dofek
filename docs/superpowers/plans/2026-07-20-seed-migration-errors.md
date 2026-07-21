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

- Unit: drive the seeder's public execution boundary with a database adapter that rejects a migration statement and assert a non-zero failure preserving the exact migration filename, failed SQL statement, and original database error.
- Integration: run against a fresh Postgres fixture with an intentionally invalid test migration or canonical migration-runner failure injection and assert the same exact filename, statement, and original database error context.
- UI/mobile/web parity: not applicable; both review clients depend on the same seed database.

## File Structure

- Modify: `scripts/seed-dev-db.ts` - use the canonical migration runner or classify only proven idempotent duplicate cases.
- Create: `scripts/seed-dev-db.test.ts` - cover fatal migration failure and successful fresh-schema setup.

## Tasks

### Task 1: Add Failing Tests

- [ ] Write a failing test showing a non-duplicate migration error is swallowed and seeding continues today; assert the exact migration filename, failed SQL statement, and original database error are preserved, the seed phase is never invoked, and no seed rows are written after the migration failure.
- [ ] Run `rtk pnpm vitest run --project unit scripts/seed-dev-db.test.ts`.
- [ ] Confirm the failure is specifically the missing propagation.

### Task 2: Implement the Minimal Fix

- [ ] Route schema setup through the canonical migration mechanism or propagate all unexpected SQL errors with migration-file context.
- [ ] Keep reruns deterministic without broad catch-and-continue behavior.
- [ ] Run the focused test.

### Task 3: Final Verification

- [ ] Run the seeder against a fresh disposable Postgres database and verify migrations plus seed validation succeed.
- [ ] Run `rtk pnpm lint`, `rtk pnpm typecheck`, and the focused tests.
- [ ] Confirm an injected invalid statement stops immediately with a non-zero status and reports its exact migration filename, failed statement, and original database error.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete documentation or skill improvement.
