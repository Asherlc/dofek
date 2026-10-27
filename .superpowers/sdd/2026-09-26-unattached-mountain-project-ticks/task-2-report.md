# Task 2 report: independent Mountain Project tick sync

## Result

Mountain Project now persists one `fitness.climbing_entry` row per supported
tick, keyed by owner, provider, and the existing stable tick external ID. The
provider refreshes its own tick fields and raw export payload on conflict,
clears absence state when a tick returns, and leaves `activity_id` and
`unattached_date` untouched on conflict so a manual association survives.
New rows receive the UTC export date. Full supported exports tombstone absent
tick identities without deleting rows. Empty or unsupported-only exports skip
absence reconciliation, and failed requests return before any database writes.
The provider no longer creates or reconciles wrapper activities.

## Validation

- `pnpm exec vitest run --project unit src/providers/mountain-project.test.ts` — PASS, 11 tests.
- `pnpm test:integration -- src/providers/mountain-project-sync.integration.test.ts` — PASS, 2 tests against PostgreSQL.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check src/db/index.ts src/providers/mountain-project.ts src/providers/mountain-project.test.ts src/providers/mountain-project-sync.integration.test.ts` — PASS.

The required first RED run failed on the old wrapper behavior: it observed
`upsertProviderActivity()` calls where the new test required none. An initial
typecheck also showed that adding `update` to `SyncDatabase` would invalidate
many test mocks, so absence marking uses the existing parameterized
`db.execute` contract instead; the database interface remains unchanged.

## Retrospective

The existing stable tick identity and migration-provided partial unique index
made conflict upserts straightforward. PostgreSQL integration coverage was
useful to prove that a real attachment and raw payload survive resync, and that
absence restoration does not delete history. The main investigation was
confirming that the shared activity reconciliation helper cannot target
climbing entries; the focused SQL update uses the existing `SyncDatabase`
execute boundary and only runs for nonempty supported exports.

For future sync work, useful context is that climbing-entry provider absence is
separate from `fitness.activity` absence; an empty set must remain a no-op for
Mountain Project. The `integration-tests-ready` and
`superpowers:test-driven-development` skills fit this work. No production
incident occurred. No documentation update is required; the task brief and this
report record the contract. One useful future wording improvement to the
provider absence guidance would be to explicitly distinguish activity
tombstones from other provider-owned record tombstones.
