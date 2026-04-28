# Review App Seed Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `pnpm seed` into a deterministic review-app dataset that populates the main web and mobile reviewer surfaces.

**Architecture:** Keep `scripts/seed-dev-db.ts` as the single seed entry point, but move surface-specific data generation into `scripts/seed/*.ts` modules. Tests assert reviewer-facing data contracts rather than exact fixture snapshots.

**Tech Stack:** TypeScript, `tsx`, `postgres`, TimescaleDB, Vitest integration tests, Docker Compose.

---

## File Structure

- Create `scripts/seed/helpers.ts`: seed constants, deterministic generator, local date/timestamp helpers, seed-owned provider IDs, and shared typed SQL type aliases.
- Create `scripts/seed/core.ts`: baseline user, auth session, providers, priorities, settings, sport settings, sync logs, and seed-owned cleanup.
- Create `scripts/seed/recovery.ts`: daily metrics, sleep sessions, sleep stages, and recovery edge cases.
- Create `scripts/seed/training.ts`: activities, metric streams, intervals, strength exercises, strength workouts, and sets.
- Create `scripts/seed/nutrition.ts`: nutrition daily rows, food entries, food-entry nutrition, supplements, and supplement nutrition.
- Create `scripts/seed/body-health.ts`: body measurements, DEXA scans, lab panels/results, medication/condition/allergy data, and menstrual periods.
- Create `scripts/seed/review-surfaces.ts`: journal entries, life events, and breathwork sessions.
- Modify `scripts/seed-dev-db.ts`: orchestrate modules, refresh views loudly, and verify the seeded contract.
- Modify `src/db/seed-dev-db.integration.test.ts`: add failing contract tests first, then update assertions after implementation.
- Modify `docs/review-apps.md`, `deploy/review-apps/README.md`, and `scripts/README.md`: document comprehensive deterministic seed behavior.

## Task 1: Write Seed Contract Test

**Files:**
- Modify: `src/db/seed-dev-db.integration.test.ts`

- [ ] **Step 1: Replace narrow assertions with reviewer contract assertions**

Add helpers inside the existing test file:

```ts
interface CountRow {
  count: number;
}

async function countRows(sql: postgres.Sql, tableName: string): Promise<number> {
  const [row] = await sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM ${sql("fitness." + tableName)}
  `;
  if (!row) throw new Error(`Missing count for ${tableName}`);
  return row.count;
}

async function countRowsWhereUser(sql: postgres.Sql, tableName: string): Promise<number> {
  const [row] = await sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM ${sql("fitness." + tableName)}
    WHERE user_id = ${userId}
  `;
  if (!row) throw new Error(`Missing count for ${tableName}`);
  return row.count;
}
```

Update the test to run the seed twice and assert:

```ts
await runSeed(ctx.connectionString);
const firstCounts = await readSeedCounts(sql);
await runSeed(ctx.connectionString);
const secondCounts = await readSeedCounts(sql);

expect(firstCounts).toEqual(secondCounts);
expect(firstCounts.providers).toBeGreaterThanOrEqual(5);
expect(firstCounts.dailyMetrics).toBeGreaterThanOrEqual(170);
expect(firstCounts.sleepSessions).toBeGreaterThanOrEqual(100);
expect(firstCounts.sleepStages).toBeGreaterThanOrEqual(250);
expect(firstCounts.activities).toBeGreaterThanOrEqual(90);
expect(firstCounts.metricStream).toBeGreaterThanOrEqual(1_000);
expect(firstCounts.activityIntervals).toBeGreaterThanOrEqual(10);
expect(firstCounts.strengthWorkouts).toBeGreaterThanOrEqual(12);
expect(firstCounts.strengthSets).toBeGreaterThanOrEqual(80);
expect(firstCounts.nutritionDaily).toBeGreaterThanOrEqual(85);
expect(firstCounts.foodEntries).toBeGreaterThanOrEqual(20);
expect(firstCounts.supplements).toBeGreaterThanOrEqual(3);
expect(firstCounts.bodyMeasurements).toBeGreaterThanOrEqual(50);
expect(firstCounts.labPanels).toBeGreaterThanOrEqual(2);
expect(firstCounts.labResults).toBeGreaterThanOrEqual(8);
expect(firstCounts.dexaScans).toBeGreaterThanOrEqual(2);
expect(firstCounts.journalEntries).toBeGreaterThanOrEqual(30);
expect(firstCounts.lifeEvents).toBeGreaterThanOrEqual(3);
expect(firstCounts.breathworkSessions).toBeGreaterThanOrEqual(10);
expect(firstCounts.menstrualPeriods).toBeGreaterThanOrEqual(4);
expect(firstCounts.syncLogs).toBeGreaterThanOrEqual(10);
expect(firstCounts.vSleep).toBeGreaterThanOrEqual(90);
expect(firstCounts.vDailyMetrics).toBeGreaterThanOrEqual(170);
expect(firstCounts.vBodyMeasurement).toBeGreaterThanOrEqual(50);
expect(firstCounts.activitySummary).toBeGreaterThanOrEqual(80);
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run:

```bash
docker compose up -d db redis
docker compose ps db redis
pnpm vitest src/db/seed-dev-db.integration.test.ts --run
```

Expected: FAIL because the current seed does not create the required comprehensive counts.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/db/seed-dev-db.integration.test.ts
git commit -m "Test comprehensive seed database contract"
```

## Task 2: Add Seed Helpers And Core Data

**Files:**
- Create: `scripts/seed/helpers.ts`
- Create: `scripts/seed/core.ts`
- Modify: `scripts/seed-dev-db.ts`

- [ ] **Step 1: Create helper primitives**

Create deterministic helpers:

```ts
export const USER_ID = "00000000-0000-0000-0000-000000000001";
export const SEED_PROVIDER_IDS = [
  "whoop",
  "apple_health",
  "strava",
  "bodyspec",
  "manual_review",
] as const;

export class SeedRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  float(min: number, max: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round((this.next() * (max - min) + min) * factor) / factor;
  }
}
```

- [ ] **Step 2: Add core seed module**

Create functions:

```ts
export async function clearSeedData(sql: Sql): Promise<void> {
  await sql`DELETE FROM fitness.sleep_stage WHERE session_id IN (
    SELECT id FROM fitness.sleep_session WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.metric_stream WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.session WHERE user_id = ${USER_ID}`;
}

export async function seedCore(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO fitness.user_profile (id, name, email, max_hr, resting_hr, ftp)
    VALUES (${USER_ID}, 'Review User', 'review@example.com', 190, 52, 285)
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          email = EXCLUDED.email,
          max_hr = EXCLUDED.max_hr,
          resting_hr = EXCLUDED.resting_hr,
          ftp = EXCLUDED.ftp
  `;
}
```

`clearSeedData` must delete seed-owned rows in dependency order. `seedCore` must create the baseline user, `dev-session`, five providers, provider priorities, sport settings, `unitSystem`, `goalWeight`, and realistic sync logs with both success and failed statuses.

- [ ] **Step 3: Wire core module into the seed entry point**

Replace inline user/provider/session setup in `scripts/seed-dev-db.ts` with calls to:

```ts
await clearSeedData(sql);
await seedCore(sql);
```

- [ ] **Step 4: Run the integration test**

Run:

```bash
pnpm vitest src/db/seed-dev-db.integration.test.ts --run
```

Expected: still FAIL because surface modules are not seeded yet, but baseline provider/session assertions should pass.

- [ ] **Step 5: Commit core seed scaffolding**

```bash
git add scripts/seed-dev-db.ts scripts/seed/helpers.ts scripts/seed/core.ts
git commit -m "Add deterministic seed core data"
```

## Task 3: Add Recovery And Training Seed Modules

**Files:**
- Create: `scripts/seed/recovery.ts`
- Create: `scripts/seed/training.ts`
- Modify: `scripts/seed-dev-db.ts`

- [ ] **Step 1: Add recovery data**

Create `seedRecovery(sql, random)` that inserts 180 days of daily metrics, 90 WHOOP sleep sessions, 30 Apple Health overlapping sleep sessions, sleep stages for recent sessions, bad sleep week data, and high-stress daily metrics.

- [ ] **Step 2: Add training data**

Create `seedTraining(sql, random)` that inserts 120 days of activities across cycling, running, hiking, walking, and strength. Insert heart-rate streams for all activities, power/cadence streams for cycling, speed/altitude streams for endurance activities, intervals for hard workouts, and strength workouts/sets linked to exercise rows.

- [ ] **Step 3: Wire modules into entry point**

Call:

```ts
await seedRecovery(sql, random);
await seedTraining(sql, random);
```

- [ ] **Step 4: Run the integration test**

Run:

```bash
pnpm vitest src/db/seed-dev-db.integration.test.ts --run
```

Expected: still FAIL until nutrition/body/review modules exist, but recovery/training counts and core materialized views should pass once refreshed.

- [ ] **Step 5: Commit recovery and training seed modules**

```bash
git add scripts/seed-dev-db.ts scripts/seed/recovery.ts scripts/seed/training.ts
git commit -m "Seed recovery and training review data"
```

## Task 4: Add Nutrition, Body Health, And Context Modules

**Files:**
- Create: `scripts/seed/nutrition.ts`
- Create: `scripts/seed/body-health.ts`
- Create: `scripts/seed/review-surfaces.ts`
- Modify: `scripts/seed-dev-db.ts`

- [ ] **Step 1: Add nutrition data**

Create `seedNutrition(sql, random)` that inserts 90 days of `nutrition_daily`, recent `food_entry` rows with `food_entry_nutrient`, and at least three supplements with `supplement_nutrient`.

- [ ] **Step 2: Add body and health data**

Create `seedBodyHealth(sql, random)` that inserts body measurements, DEXA scans and regions, lab panels and results, medication, condition, allergy/intolerance, medication dose events, and menstrual periods.

- [ ] **Step 3: Add review context data**

Create `seedReviewSurfaces(sql, random)` that inserts journal entries for existing canonical questions, life events, and breathwork sessions.

- [ ] **Step 4: Wire modules into entry point**

Call:

```ts
await seedNutrition(sql, random);
await seedBodyHealth(sql, random);
await seedReviewSurfaces(sql, random);
```

- [ ] **Step 5: Run the integration test**

Run:

```bash
pnpm vitest src/db/seed-dev-db.integration.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit remaining seed modules**

```bash
git add scripts/seed-dev-db.ts scripts/seed/nutrition.ts scripts/seed/body-health.ts scripts/seed/review-surfaces.ts
git commit -m "Seed nutrition body and review context data"
```

## Task 5: Harden View Refresh, Verification, And Docs

**Files:**
- Modify: `scripts/seed-dev-db.ts`
- Modify: `docs/review-apps.md`
- Modify: `deploy/review-apps/README.md`
- Modify: `scripts/README.md`

- [ ] **Step 1: Fail loudly on core view refresh failures**

Change `refreshViews` so failures for `v_sleep`, `v_daily_metrics`, `v_body_measurement`, `v_activity`, `deduped_sensor`, and `activity_summary` throw instead of being ignored.

- [ ] **Step 2: Add seed verification output**

Verify representative counts for providers, daily metrics, sleep, activities, metric streams, nutrition, body, labs, journal, breathwork, cycle, and materialized views before printing success.

- [ ] **Step 3: Update documentation**

Document that `pnpm seed` creates a deterministic comprehensive reviewer account, review apps run it during deploy, and `/auth/dev-login` opens the seeded account.

- [ ] **Step 4: Run targeted validation**

Run:

```bash
pnpm vitest src/db/seed-dev-db.integration.test.ts --run
pnpm lint
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd ../web && pnpm tsc --noEmit
```

Expected: all pass.

- [ ] **Step 5: Commit docs and verification hardening**

```bash
git add scripts/seed-dev-db.ts docs/review-apps.md deploy/review-apps/README.md scripts/README.md
git commit -m "Document comprehensive review seed data"
```

## Task 6: Final Pre-Push Verification

**Files:**
- No file edits expected.

- [ ] **Step 1: Run required pre-push checks**

Run:

```bash
docker compose up -d db redis
docker compose ps db redis
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd ../web && pnpm tsc --noEmit
```

Expected: all pass.

- [ ] **Step 2: Push branch**

Run:

```bash
git push
```
