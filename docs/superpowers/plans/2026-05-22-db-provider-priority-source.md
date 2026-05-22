# DB Provider Priority Source Implementation Plan

> Follow the tasks in order and check off each step as it is completed.

**Goal:** Make Postgres priority tables the runtime source of truth and remove the runtime `provider-priority.json` sync path.

**Architecture:** Seed default provider/device priorities through a forward SQL migration, define the priority tables in Drizzle schema, stop global post-sync maintenance from reading JSON, and keep ClickHouse/PeerDB priority consumers table-based. Add sensor priority/audit tables for the upcoming sensor-stream priority model.

**Tech Stack:** TypeScript, Drizzle schema, raw SQL migrations, Vitest.

---

## Task 1: Prove global maintenance no longer syncs JSON priorities

**Files:**
- Modify: `src/jobs/process-post-sync-job.test.ts`
- Modify: `src/jobs/process-post-sync-job.ts`

- [ ] **Step 1: Write the failing test**

Replace provider-priority mocks with a test that asserts global maintenance does not import or call `syncProviderPriorities`.

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm vitest run src/jobs/process-post-sync-job.test.ts`

Expected: FAIL while production still imports `../db/provider-priority.ts` and calls the sync function.

- [ ] **Step 3: Remove runtime JSON priority sync**

Delete the priority sync block from `processPostSyncJob()`. Global maintenance should log start and complete without touching provider priorities.

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm vitest run src/jobs/process-post-sync-job.test.ts`

Expected: PASS.

## Task 2: Add DB-owned priority schema and seed migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0026_seed_provider_priorities.sql`
- Modify: `src/db/provider-priority.test.ts`

- [ ] **Step 1: Write failing schema/migration tests**

Update provider-priority tests so they assert exported Drizzle tables exist for `provider_priority`, `device_priority`, `sensor_provider_priority`, `sensor_device_priority`, and `provider_priority_audit`, and assert no JSON loader API exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm vitest run src/db/provider-priority.test.ts`

Expected: FAIL because schema exports and migration seed checks do not exist yet.

- [ ] **Step 3: Add Drizzle table definitions**

Add schema exports for the priority tables. Keep existing table names and add new sensor/audit tables.

- [ ] **Step 4: Add forward migration**

Create `drizzle/0026_seed_provider_priorities.sql` to:
- create sensor priority and audit tables,
- seed current provider and device priority defaults,
- avoid deleting existing rows,
- use `ON CONFLICT DO UPDATE` for idempotency.

- [ ] **Step 5: Remove JSON runtime module behavior**

Replace `src/db/provider-priority.ts` with DB-oriented exports only, or delete tests for JSON loading and syncing.

- [ ] **Step 6: Run test to verify it passes**

Run: `rtk pnpm vitest run src/db/provider-priority.test.ts`

Expected: PASS.

## Task 3: Remove JSON artifact and Docker copy

**Files:**
- Delete: `provider-priority.json`
- Modify: `Dockerfile`
- Modify: `src/personalization/refit.integration.test.ts`

- [ ] **Step 1: Write/adjust failing checks**

Update tests/imports so no runtime code imports `loadProviderPriorityConfig` or `syncProviderPriorities`.

- [ ] **Step 2: Run targeted search**

Run: `rtk rg -n "provider-priority\\.json|loadProviderPriorityConfig|syncProviderPriorities" Dockerfile src packages scripts`

Expected before implementation: FAIL-style evidence because references remain.

- [ ] **Step 3: Remove references**

Delete the JSON file, remove the Dockerfile copy line, and remove integration-test setup that manually syncs JSON priorities.

- [ ] **Step 4: Re-run targeted search**

Run: `rtk rg -n "provider-priority\\.json|loadProviderPriorityConfig|syncProviderPriorities" Dockerfile src packages scripts`

Expected: no runtime references.

## Task 4: Verify

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-05-22-clickhouse-incremental-deduped-sensor-design.md`
- Modify if needed: `docs/production-incident-baseline.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
rtk pnpm vitest run src/jobs/process-post-sync-job.test.ts src/db/provider-priority.test.ts src/db/clickhouse-cdc.test.ts src/db/clickhouse.test.ts
```

- [ ] **Step 2: Run static checks**

Run:

```bash
rtk pnpm lint
rtk pnpm tsc --noEmit
```

- [ ] **Step 3: Report remaining rollout work**

Call out that production needs the new migration applied and PeerDB mirror reconciliation for any new priority tables before ClickHouse can consume sensor-channel priority.
