# Metric Stream Location Rebuild Implementation Plan

> **For agentic workers:** Optional implementation helpers include `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `fitness.metric_stream` into a replacement hypertable that stores canonical `location` point rows and omits legacy `lat`/`lng` rows without mutating old compressed chunks in place.

**Architecture:** A TypeScript production script creates a replacement hypertable, records chunk/range copy tasks, copies one bounded range at a time with SQL transformation, validates row counts, and immediately compresses completed replacement chunks. The final cutover is a short locked table swap after historical tasks are complete and the recent tail has been copied.

**Tech Stack:** TypeScript scripts run with `pnpm tsx`, Postgres/TimescaleDB SQL over SSH, Vitest unit tests for generated SQL and CLI parsing.

---

## Task 1: Add Rebuild SQL Builder Tests

**Files:**
- Create: `scripts/rebuild-metric-stream-location.test.ts`
- Create/Modify: `scripts/rebuild-metric-stream-location.ts`

- [ ] **Step 1: Write failing tests**

Test that setup SQL creates `fitness.metric_stream_rebuild`, configures Timescale compression, and creates a task table. Test that copy SQL inserts non-legacy rows, generates `location` rows from `lat`/`lng`, omits represented `gps_accuracy`, validates counts, and compresses replacement chunks.

- [ ] **Step 2: Run red test**

Run: `pnpm vitest run scripts/rebuild-metric-stream-location.test.ts`
Expected: FAIL because `scripts/rebuild-metric-stream-location.ts` does not exist.

## Task 2: Implement Rebuild Script

**Files:**
- Create: `scripts/rebuild-metric-stream-location.ts`

- [ ] **Step 1: Implement CLI**

Support `--prepare`, `--copy`, `--swap`, `--execute`, `--max-tasks`, `--ssh-host`, and `--statement-timeout`.

- [ ] **Step 2: Implement setup SQL**

Create `fitness.metric_stream_rebuild` with final columns, make it a 1-day hypertable, set aggressive compression, add the primary key and provider external unique index, and create `fitness.metric_stream_rebuild_task`.

- [ ] **Step 3: Implement copy SQL**

For each task range, insert all non-legacy rows, insert canonical `location` rows from paired `lat`/`lng` rows with `gps_accuracy_m` metadata, validate expected counts, mark task complete, and compress replacement chunks overlapping the task range.

- [ ] **Step 4: Implement swap SQL**

Lock old and replacement tables, copy the tail, validate no incomplete tasks, rename old table aside, rename replacement to `metric_stream`, restore indexes/FKs/replica identity, and leave the old table available for rollback until explicit cleanup.

## Task 3: Validate Locally

**Files:**
- Test: `scripts/rebuild-metric-stream-location.test.ts`

- [ ] **Step 1: Run targeted tests**

Run: `pnpm vitest run scripts/rebuild-metric-stream-location.test.ts`
Expected: PASS.

- [ ] **Step 2: Run TypeScript checks**

Run: `pnpm tsc --noEmit`
Expected: PASS.

## Task 4: Start Production Backfill

**Files:**
- Run: `scripts/rebuild-metric-stream-location.ts`

- [ ] **Step 1: Prepare replacement table**

Run dry-run first, then execute `--prepare`. Confirm disk headroom and task count.

- [ ] **Step 2: Copy one task**

Run `--copy --max-tasks 1 --execute`. Confirm replacement chunks are compressed immediately and report `% done`.

- [ ] **Step 3: Continue bounded tasks**

Continue with small `--max-tasks` batches while reporting disk, completed tasks, total tasks, percent done, and active DB statements.
