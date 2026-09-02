# Hangboarding Import and Training UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the finalized Hang Ten Apple Health importer into this branch and expose Hangboarding metadata, work/rest intervals, activity details, and climbing-page metrics on web and mobile.

**Architecture:** Extend the existing Apple Health XML pipeline and reuse `fitness.activity_interval`; Hang Ten remains an Apple Health source but is classified as canonical `hangboard`. A focused server repository will expose validated activity-detail metadata and date-range summaries, and both clients will render those server-computed values without calculating metrics.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, tRPC, Vitest, React/Vite, Expo/React Native, existing ECharts and SVG chart components.

## Global Constraints

- Reuse the finalized importer behavior from the local `codex/hang-ten-apple-health-import` ref; do not cherry-pick its historical migration number because this branch already uses migration `0071`.
- Keep `provider_id = apple_health`; recognize Hang Ten only for functional-strength workouts branded exactly `Hang Ten` with a non-empty `HangTen.PlanName`.
- Use internal canonical type `hangboard` and user-facing label `Hangboarding`.
- Preserve Hang Ten provenance in `activity.raw.hangTen`; use `fitness.activity_interval` for ordered work/rest segments; do not add duplicate Hang Ten tables or columns.
- Keep all interval timestamps, aggregate metrics, trend values, and missing-data decisions on the server.
- Do not ingest, compute, or display provider-estimated calories, inferred hang load, or invented set/repetition values.
- Implement equivalent behavior in `packages/web` and `packages/mobile`.
- Follow TDD: each production behavior begins with a failing test, and database behavior uses executable integration tests.
- Use `rtk` before every shell command and use `apply_patch` for file edits.

---

## File map

### Importer and domain files

- `packages/training/src/activity-types.ts`, `packages/training/src/training.ts`: register the `hangboard` canonical type and `Hangboarding` label.
- `packages/training/src/activity-types.test.ts`, `packages/training/src/training.test.ts`: prove the type and label contract.
- `src/db/schema/enums.ts`, `drizzle/0072_add_hangboard_activity_type.sql`, `drizzle/meta/_journal.json`: add the forward-only current-branch enum migration.
- `src/providers/apple-health/workouts.ts`: parse Hang Ten metadata, typed segments, canonical type, display name inputs, and stable external IDs.
- `src/providers/apple-health/streaming.ts`: collect nested `MetadataEntry` values while a workout is open.
- `src/providers/apple-health/hang-ten-intervals.ts`: build and idempotently replace activity intervals.
- `src/providers/apple-health/db-insertion.ts`: persist Hang Ten raw payloads and intervals.
- `src/providers/apple-health/import.ts`: report malformed segment JSON as a non-fatal import error.
- `src/providers/apple-health/*test.ts`: port the finalized importer tests from the historical ref and add current-branch regression coverage.

### Server files

- `packages/server/src/repositories/hangboarding-repository.ts`: read Hangboarding detail metadata and server-computed range summaries.
- `packages/server/src/repositories/hangboarding-repository.test.ts`: unit-test row mapping and summary reduction helpers.
- `packages/server/src/repositories/hangboarding-repository.integration.test.ts`: execute the summary/detail queries against Postgres fixtures.
- `packages/server/src/routers/activity.ts`, `activity.test.ts`, `activity.integration.test.ts`: expose `activity.hangboardDetails`.
- `packages/server/src/routers/climbing.ts`, `climbing.test.ts`, `climbing.integration.test.ts`: expose `climbing.hangboardingSummary`.
- `packages/server/src/contracts/mobile-dashboard-contracts.ts`: validate the mobile training payload's `climbing.hangboarding` block.
- `packages/server/src/services/mobile-training-tab.ts`, `mobile-training-tab.test.ts`: load the same summary for mobile.

### Web files

- `packages/web/src/components/HangboardingDetail.tsx`, `.test.tsx`, `.stories.tsx`: render plan/board/session metadata and interval rows.
- `packages/web/src/components/HangboardingSummary.tsx`, `.test.tsx`, `.stories.tsx`: render metric cards and the daily trend.
- `packages/web/src/pages/ActivityDetailPage.tsx`, `.test.tsx`: query and render Hangboarding activity details.
- `packages/web/src/routes/training/climbing.tsx`, `.test.tsx`: query and render Hangboarding summary data.

### Mobile files

- `packages/mobile/components/HangboardingDetail.tsx`, `.test.tsx`, `.stories.tsx`: render the activity-detail interval and metadata block.
- `packages/mobile/components/HangboardingSummary.tsx`, `.test.tsx`, `.stories.tsx`: render the compact climbing-card metrics and trend.
- `packages/mobile/app/activity/[id].tsx`, `packages/mobile/app-tests/activity/[id].test.tsx`: query and render Hangboarding detail.
- `packages/mobile/app/(tabs)/strain.tsx`, `packages/mobile/app-tests/(tabs)/strain.test.tsx`: parse and render the mobile training summary.

---

### Task 1: Register the canonical Hangboard activity type

**Files:**

- Modify: `packages/training/src/activity-types.ts`
- Modify: `packages/training/src/activity-types.test.ts`
- Modify: `packages/training/src/training.ts`
- Modify: `packages/training/src/training.test.ts`
- Modify: `src/db/schema/enums.ts`
- Create: `drizzle/0072_add_hangboard_activity_type.sql`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**

- Produces the shared canonical string literal `"hangboard"`.
- Produces `formatActivityTypeLabel("hangboard") === "Hangboarding"`.
- Produces the Postgres enum value `fitness.canonical_activity_type = 'hangboard'`.

- [ ] **Step 1: Add failing shared type and label assertions**

Add these assertions to the existing activity-type/training test suites:

```ts
expect(CANONICAL_ACTIVITY_TYPES).toContain("hangboard");
expect(formatActivityTypeLabel("hangboard")).toBe("Hangboarding");
expect(resolveProviderActivityType("Hang Ten", "hangboard")).toMatchObject({
  canonicalType: "hangboard",
  providerType: "Hang Ten",
});
```

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

```bash
rtk pnpm vitest packages/training/src/activity-types.test.ts packages/training/src/training.test.ts
```

Expected failure: the canonical type list and label map do not contain
`hangboard`.

- [ ] **Step 3: Add the shared type and user-facing label**

Add `"hangboard"` to `CANONICAL_ACTIVITY_TYPES` near `climbing` in
`packages/training/src/activity-types.ts` and add this label entry in
`packages/training/src/training.ts`:

```ts
hangboard: "Hangboarding",
```

- [ ] **Step 4: Add the current-branch database migration**

Create `drizzle/0072_add_hangboard_activity_type.sql`:

```sql
ALTER TYPE fitness.canonical_activity_type
  ADD VALUE IF NOT EXISTS 'hangboard' AFTER 'climbing';
```

Update `drizzle/meta/_journal.json` with the repository's normal migration
entry for `0072_add_hangboard_activity_type`. Do not recreate or rename the
existing `0071_processing_alert_dismissal` migration.

- [ ] **Step 5: Run the focused tests and schema checks**

Run:

```bash
rtk pnpm vitest packages/training/src/activity-types.test.ts packages/training/src/training.test.ts src/db/schema/enums.test.ts
rtk pnpm lint:db
```

Expected: all tests pass and the migration/schema policy check exits zero.

- [ ] **Step 6: Commit the canonical type**

```bash
rtk git add packages/training/src/activity-types.ts packages/training/src/activity-types.test.ts packages/training/src/training.ts packages/training/src/training.test.ts src/db/schema/enums.ts drizzle/0072_add_hangboard_activity_type.sql drizzle/meta/_journal.json
rtk git commit -m "feat: add Hangboarding activity type"
```

---

### Task 2: Port the typed Hang Ten Apple Health parser

**Files:**

- Modify: `src/providers/apple-health/workouts.ts`
- Modify: `src/providers/apple-health/streaming.ts`
- Modify: `src/providers/apple-health/parsing.test.ts`
- Modify: `src/providers/apple-health/parsing-extra.test.ts`
- Modify: `src/providers/apple-health/streaming.test.ts`

**Interfaces:**

- Consumes the `hangboard` type from Task 1.
- Produces `HealthWorkout.metadata?: Record<string, string>`.
- Produces `HealthWorkout.hangTen?: HangTenWorkoutMetadata`.
- Produces `workoutExternalId(workout: HealthWorkout): string`.

Use these exact domain shapes:

```ts
interface HangTenActivitySegment {
  stepID: string;
  stepNumber: number;
  kind: "work" | "rest";
  holdIDs: string[];
  holdType?: string;
  sizeMillimeters?: number;
  durationSeconds?: number;
}

interface HangTenWorkoutMetadata {
  sessionId?: string;
  planName: string;
  boardId?: string;
  boardName?: string;
  rawActivitySegments?: string;
  activitySegments?: HangTenActivitySegment[];
  activitySegmentsError?: string;
}
```

- [ ] **Step 1: Port failing parser tests from the finalized historical ref**

Use `rtk git show codex/hang-ten-apple-health-import:<path>` to copy the
finalized Hang Ten cases into current colocated tests. The first test must
assert that a functional-strength workout with these metadata values:

```ts
{
  HKMetadataKeyWorkoutBrandName: "Hang Ten",
  "HangTen.PlanName": "7/3 Repeaters",
  "HangTen.SessionID": "11111111-1111-4111-8111-111111111111",
  "HangTen.BoardID": "metolius-compact-ii",
  "HangTen.BoardName": "Metolius Compact II",
  "HangTen.ActivitySegments": JSON.stringify({
    version: 1,
    segments: [{
      stepID: "step-1",
      stepNumber: 1,
      kind: "work",
      holdIDs: ["edge-19"],
      holdType: "edge",
      sizeMillimeters: 19,
      durationSeconds: 7,
    }],
  }),
}
```

produces canonical type `hangboard`, source `Hang Ten`, plan name, board
metadata, and one parsed segment. Add failing cases for non-functional
strength workouts, missing/blank plan names, exact brand matching, malformed
JSON, empty segment arrays, and structurally invalid segments.

- [ ] **Step 2: Run parser tests and verify they fail for missing behavior**

```bash
rtk pnpm vitest src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts src/providers/apple-health/streaming.test.ts
```

Expected failure: `parseWorkout` does not accept metadata and the streaming
parser does not attach `MetadataEntry` values.

- [ ] **Step 3: Implement the minimal typed metadata parser**

Port the finalized parser behavior from `50c993e03` and `c4a653992`:

- change `parseWorkout(attrs)` to `parseWorkout(attrs, metadata = {})`;
- parse and validate `HangTen.ActivitySegments` with Zod;
- preserve malformed raw segment JSON and a specific error string;
- override only qualifying functional-strength workouts to
  `resolveProviderActivityType("Hang Ten", "hangboard")`;
- preserve `metadata` on the `HealthWorkout`; and
- use the Hang Ten session ID for `workoutExternalId` when present.

In `streaming.ts`, collect nested `MetadataEntry` attributes only while a
workout is open, pass the map to `parseWorkout`, and clear the map when the
workout closes. Keep unrelated workout parsing unchanged.

- [ ] **Step 4: Run parser tests and verify they pass**

```bash
rtk pnpm vitest src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts src/providers/apple-health/streaming.test.ts
```

Expected: all parser and streaming tests pass with no warnings.

- [ ] **Step 5: Commit the parser**

```bash
rtk git add src/providers/apple-health/workouts.ts src/providers/apple-health/streaming.ts src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts src/providers/apple-health/streaming.test.ts
rtk git commit -m "feat: parse Hang Ten Apple Health metadata"
```

---

### Task 3: Persist Hang Ten metadata and activity intervals

**Files:**

- Create: `src/providers/apple-health/hang-ten-intervals.ts`
- Create: `src/providers/apple-health/hang-ten-intervals.test.ts`
- Modify: `src/providers/apple-health/db-insertion.ts`
- Modify: `src/providers/apple-health/db-insertion.test.ts`
- Modify: `src/providers/apple-health/db-insertion.integration.test.ts`
- Modify: `src/providers/apple-health/import.ts`
- Modify: `src/providers/apple-health/import.test.ts`
- Modify: `src/providers/apple-health/import.integration.test.ts`
- Modify: `src/providers/apple-health/test-helpers.ts`

**Interfaces:**

- Consumes `HealthWorkout.hangTen` and `workoutExternalId` from Task 2.
- Produces `hangTenIntervalLabel(segment)`, `buildHangTenIntervals(activityId, workout)`, and `replaceHangTenIntervals(db, activityId, workout)`.
- Produces activity rows with `name = HangTen.PlanName`, canonical type
  `hangboard`, source `Hang Ten`, and raw payload key `hangTen`.

- [ ] **Step 1: Write failing interval and insertion tests**

Port the finalized tests from `cdf418e6f`, `b9eaa8cd2`, `e9a193e4a`, and
`c4a653992`. At minimum, assert:

```ts
expect(hangTenIntervalLabel({
  stepID: "step-1",
  stepNumber: 1,
  kind: "work",
  holdIDs: ["edge-19"],
  holdType: "edge",
  sizeMillimeters: 19,
})).toBe("Step 1: 19 mm edge");

expect(hangTenIntervalLabel({
  stepID: "step-1-rest",
  stepNumber: 1,
  kind: "rest",
  holdIDs: [],
})).toBe("Step 1: Rest");
```

Add an integration test that imports a Hang Ten workout twice with changed
segments and proves the second import leaves exactly the replacement interval
set. Add a malformed-segment test that keeps the activity row, stores the
error in raw metadata, and inserts no intervals.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

```bash
rtk pnpm vitest src/providers/apple-health/hang-ten-intervals.test.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/import.test.ts
```

Expected failure: the interval helper and Hang Ten persistence behavior are
missing.

- [ ] **Step 3: Add interval construction and replacement**

Port `hang-ten-intervals.ts` from the finalized ref. Use `interval_index` in
segment order, `interval_type` values `work`/`rest`, and derive `ended_at`
only while all preceding durations are known. Delete existing intervals for
the activity before inserting the replacement set in one database statement.

- [ ] **Step 4: Update workout insertion**

Port the finalized `db-insertion.ts` behavior:

- deduplicate by `workoutExternalId`;
- write `durationSeconds`, `distanceMeters`, `avgHeartRate`, and
  `maxHeartRate` into the existing raw payload;
- include the typed Hang Ten metadata in `raw.hangTen`;
- use the plan name as the activity name;
- update an existing Hang Ten activity's name/raw payload on reimport; and
- call `replaceHangTenIntervals` after each returned Hang Ten activity ID.

Do not add calories or provider-estimated expenditure to the raw payload.

- [ ] **Step 5: Thread malformed metadata errors through import reporting**

Port the existing non-fatal import error behavior from the historical ref.
The import still returns the workout count and writes the activity; it adds a
specific sync error containing the workout external ID and parser error when
`activitySegmentsError` is present.

- [ ] **Step 6: Run unit and database integration tests**

```bash
rtk pnpm vitest src/providers/apple-health/hang-ten-intervals.test.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/import.test.ts
rtk pnpm test:integration -- src/providers/apple-health/db-insertion.integration.test.ts src/providers/apple-health/import.integration.test.ts
```

Expected: Hang Ten activities and replacement intervals are verified against
the real Postgres engine.

- [ ] **Step 7: Commit the persistence layer**

```bash
rtk git add src/providers/apple-health/hang-ten-intervals.ts src/providers/apple-health/hang-ten-intervals.test.ts src/providers/apple-health/db-insertion.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/db-insertion.integration.test.ts src/providers/apple-health/import.ts src/providers/apple-health/import.test.ts src/providers/apple-health/import.integration.test.ts src/providers/apple-health/test-helpers.ts
rtk git commit -m "feat: persist Hang Ten workout intervals"
```

---

### Task 4: Add server Hangboarding detail and summary contracts

**Files:**

- Create: `packages/server/src/repositories/hangboarding-repository.ts`
- Create: `packages/server/src/repositories/hangboarding-repository.test.ts`
- Create: `packages/server/src/repositories/hangboarding-repository.integration.test.ts`
- Modify: `packages/server/src/routers/activity.ts`
- Modify: `packages/server/src/routers/activity.test.ts`
- Modify: `packages/server/src/routers/activity.integration.test.ts`
- Modify: `packages/server/src/routers/climbing.ts`
- Modify: `packages/server/src/routers/climbing.test.ts`
- Modify: `packages/server/src/routers/climbing.integration.test.ts`

**Interfaces:**

Define and export these domain shapes from the repository:

```ts
export interface HangboardingIntervalDetail {
  id: string;
  intervalIndex: number;
  label: string | null;
  intervalType: "work" | "rest" | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface HangboardingDetail {
  planName: string | null;
  sessionId: string | null;
  boardId: string | null;
  boardName: string | null;
  segmentsError: string | null;
  intervals: HangboardingIntervalDetail[];
}

export interface HangboardingSummary {
  sessionCount: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number | null;
  totalWorkDurationSeconds: number | null;
  totalRestDurationSeconds: number | null;
  workIntervalCount: number | null;
  averageHeartRate: number | null;
  peakHeartRate: number | null;
  latestSession: {
    activityId: string;
    startedAt: string;
    planName: string | null;
    boardName: string | null;
    durationSeconds: number;
  } | null;
  daily: Array<{
    date: string;
    sessionCount: number;
    durationSeconds: number;
    workDurationSeconds: number | null;
    restDurationSeconds: number | null;
  }>;
}
```

- [ ] **Step 1: Write failing repository and router tests**

Add tests for:

- detail mapping from `activity.raw->'hangTen'` and ordered intervals;
- rejection of a non-owned/non-Hangboarding activity;
- a range with two sessions and work/rest intervals producing exact totals;
- null work/rest aggregates when no intervals have usable durations;
- null heart-rate aggregates when raw HR values are absent;
- `activity.hangboardDetails({ id })` returning the detail contract; and
- `climbing.hangboardingSummary({ days })` returning the summary contract.

Use fixtures such as two sessions of 600 and 900 seconds, work intervals of
7 and 10 seconds, rest intervals of 53 and 50 seconds, and raw average/max
heart rates of 120/145 and 130/150. Assert that the server returns 2 sessions,
1500 total seconds, 750 average seconds, 17 work seconds, 103 rest seconds,
average HR 125, and peak HR 150.

- [ ] **Step 2: Run tests and verify the expected failure**

```bash
rtk pnpm vitest packages/server/src/repositories/hangboarding-repository.test.ts packages/server/src/routers/activity.test.ts packages/server/src/routers/climbing.test.ts
```

Expected failure: the repository and procedures do not exist.

- [ ] **Step 3: Implement the repository with explicit Postgres schemas**

Create `HangboardingRepository` with constructor dependencies:

```ts
constructor(
  database: Pick<Database, "execute">,
  userId: string,
  timezone: string,
  accessWindow?: AccessWindow,
)
```

Implement:

```ts
getDetail(activityId: string): Promise<HangboardingDetail | null>;
getSummary(days: number): Promise<HangboardingSummary>;
```

Use `fitness.v_activity` for visibility/access checks and join the member
`fitness.activity` rows for `raw.hangTen`, `started_at`, `ended_at`, and raw
heart-rate values. Restrict summary rows to `canonical_type = 'hangboard'`.
Aggregate interval durations with `SUM(EXTRACT(EPOCH ...))` only when matching
interval rows have usable end times; otherwise return `null` for that metric.
Group daily rows using `(started_at AT TIME ZONE timezone)::date`, and validate
all SQL rows with Zod schemas from `typed-sql.ts`.

- [ ] **Step 4: Add tRPC procedures with actionable errors**

Add to `activityRouter`:

```ts
hangboardDetails: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
  .input(z.object({ id: z.guid() }))
  .query(async ({ ctx, input }) => {
    const repository = new HangboardingRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
    );
    return repository.getDetail(input.id);
  });
```

Return `NOT_FOUND` with `"Hangboarding details not found"` when the activity
is not visible or is not canonical `hangboard`. Add to `climbingRouter`:

```ts
hangboardingSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
  .input(daysInputSchema)
  .query(async ({ ctx, input }) => {
    const repository = new HangboardingRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
    );
    return repository.getSummary(input.days);
  });
```

Wrap repository failures with the existing climbing-query error/reporting
pattern and preserve the underlying actionable message in the tRPC error.

- [ ] **Step 5: Run server unit and integration tests**

```bash
rtk pnpm vitest packages/server/src/repositories/hangboarding-repository.test.ts packages/server/src/routers/activity.test.ts packages/server/src/routers/climbing.test.ts
rtk pnpm test:integration -- packages/server/src/repositories/hangboarding-repository.integration.test.ts packages/server/src/routers/activity.integration.test.ts packages/server/src/routers/climbing.integration.test.ts
```

Expected: exact summary math, access control, null handling, and error
contracts pass against unit fixtures and real Postgres data.

- [ ] **Step 6: Commit the server contracts**

```bash
rtk git add packages/server/src/repositories/hangboarding-repository.ts packages/server/src/repositories/hangboarding-repository.test.ts packages/server/src/repositories/hangboarding-repository.integration.test.ts packages/server/src/routers/activity.ts packages/server/src/routers/activity.test.ts packages/server/src/routers/activity.integration.test.ts packages/server/src/routers/climbing.ts packages/server/src/routers/climbing.test.ts packages/server/src/routers/climbing.integration.test.ts
rtk git commit -m "feat: expose Hangboarding activity details and summaries"
```

---

### Task 5: Thread the summary into the mobile training contract

**Files:**

- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.ts`
- Modify: `packages/server/src/services/mobile-training-tab.ts`
- Modify: `packages/server/src/services/mobile-training-tab.test.ts`
- Modify: `packages/mobile/app/(tabs)/strain.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/strain.test.tsx`

**Interfaces:**

- Extends `training.climbing` with `hangboarding: HangboardingSummary`.
- Keeps the existing `gradeProgression`, `volumeByGrade`, and `sessionSummary` fields unchanged.
- Mobile parses unknown server payloads through Zod and reports malformed
  Hangboarding rows through the existing telemetry path.

- [ ] **Step 1: Add failing mobile-contract and screen tests**

Add a server service test asserting the returned shape:

```ts
expect(result.climbing.hangboarding).toEqual({
  sessionCount: 2,
  totalDurationSeconds: 1500,
  averageDurationSeconds: 750,
  totalWorkDurationSeconds: 17,
  totalRestDurationSeconds: 103,
  workIntervalCount: 2,
  averageHeartRate: 125,
  peakHeartRate: 150,
  latestSession: expect.objectContaining({ planName: "7/3 Repeaters" }),
  daily: expect.any(Array),
});
```

Add mobile tests for visible Hangboarding metrics, empty data, malformed
rows, and a failed training query with cached data preserved.

- [ ] **Step 2: Run the tests and verify the expected failure**

```bash
rtk pnpm vitest packages/server/src/services/mobile-training-tab.test.ts packages/mobile/app-tests/'(tabs)'/strain.test.tsx
```

Expected failure: the mobile output has no `climbing.hangboarding` field.

- [ ] **Step 3: Add the server payload field**

In `loadMobileTrainingTab`, instantiate the Hangboarding repository and add
`hangboardingSummary` to the existing `Promise.all`. Return it under
`climbing.hangboarding`, then add the same nested Zod schema to
`mobile-dashboard-contracts.ts`.

- [ ] **Step 4: Parse and render the new mobile data**

Extend `mobileClimbingDataSchema`, `emptyClimbingData`, and
`ClimbingSectionModel` in `strain.tsx`. Do not calculate totals from the daily
rows. Pass the server response into a dedicated `HangboardingSummary` component
that renders metric values and a duration trend using the existing `SparkLine`.

When summary data is empty, show `No Hangboarding sessions`. When parsing
fails, retain valid climbing data and report the parse error through
`captureException`.

- [ ] **Step 5: Run mobile/server tests and commit**

```bash
rtk pnpm vitest packages/server/src/services/mobile-training-tab.test.ts packages/mobile/app-tests/'(tabs)'/strain.test.tsx
rtk git add packages/server/src/contracts/mobile-dashboard-contracts.ts packages/server/src/services/mobile-training-tab.ts packages/server/src/services/mobile-training-tab.test.ts packages/mobile/app/'(tabs)'/strain.tsx packages/mobile/app-tests/'(tabs)'/strain.test.tsx
rtk git commit -m "feat: add Hangboarding metrics to mobile training"
```

---

### Task 6: Add web Hangboarding summary and activity-detail presentation

**Files:**

- Create: `packages/web/src/components/HangboardingSummary.tsx`
- Create: `packages/web/src/components/HangboardingSummary.test.tsx`
- Create: `packages/web/src/components/HangboardingSummary.stories.tsx`
- Create: `packages/web/src/components/HangboardingDetail.tsx`
- Create: `packages/web/src/components/HangboardingDetail.test.tsx`
- Create: `packages/web/src/components/HangboardingDetail.stories.tsx`
- Modify: `packages/web/src/routes/training/climbing.tsx`
- Modify: `packages/web/src/routes/training/climbing.test.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`

**Interfaces:**

```ts
function HangboardingSummary({
  data,
  loading,
}: {
  data: HangboardingSummary | undefined;
  loading: boolean;
}): JSX.Element;

function HangboardingDetail({
  data,
  loading,
  error,
}: {
  data: HangboardingDetail | undefined;
  loading: boolean;
  error: Error | null;
}): JSX.Element;
```

- [ ] **Step 1: Write failing component and route tests**

Add component tests asserting:

- metric labels `Sessions`, `Total Time`, `Avg Session`, `Work Time`,
  `Rest Time`, and `Peak Heart Rate`;
- nullable work/rest/HR values render `—` rather than `0`;
- plan and board metadata render in the detail component;
- interval labels and durations render in index order; and
- loading and error states use the existing query-state conventions.

Extend `climbing.test.tsx` to mock `trpc.climbing.hangboardingSummary.useQuery`
and assert the Hangboarding section receives the selected range input. Extend
`ActivityDetailPage.test.tsx` to mock `trpc.activity.hangboardDetails.useQuery`
and assert it is enabled only for `activityType === "hangboard"`.

- [ ] **Step 2: Run the tests and verify the expected failure**

```bash
rtk pnpm vitest packages/web/src/components/HangboardingSummary.test.tsx packages/web/src/components/HangboardingDetail.test.tsx packages/web/src/routes/training/climbing.test.tsx packages/web/src/pages/ActivityDetailPage.test.tsx
```

Expected failure: the components, mocked procedures, and rendered sections do
not yet exist.

- [ ] **Step 3: Implement web components with server-provided values**

Build `HangboardingSummary` from metric cards and a compact daily-duration
chart using the existing chart container/theme primitives. Format seconds and
heart rate for display only; never derive new metric values. Render the latest
plan/board as a link to the activity detail when `latestSession.activityId`
exists.

Build `HangboardingDetail` as a focused metadata block plus interval table.
Use the existing activity-detail styles, `formatDurationSeconds`, and
`QueryStatePanel`. Render `segmentsError` as an actionable data-quality note
without hiding valid metadata or intervals.

- [ ] **Step 4: Wire the web routes**

In `climbing.tsx`, query `trpc.climbing.hangboardingSummary` with the same
training range input as the other climbing queries, render explicit loading,
error, and empty states, and invalidate it after relevant activity changes.

In `ActivityDetailPage.tsx`, gate
`trpc.activity.hangboardDetails.useQuery({ id })` on `activityType ===
"hangboard"`, render `HangboardingDetail`, and display the shared
`Hangboarding` label through `formatActivityTypeLabel`.

- [ ] **Step 5: Run web tests and commit**

```bash
rtk pnpm vitest packages/web/src/components/HangboardingSummary.test.tsx packages/web/src/components/HangboardingDetail.test.tsx packages/web/src/routes/training/climbing.test.tsx packages/web/src/pages/ActivityDetailPage.test.tsx
rtk git add packages/web/src/components/HangboardingSummary.tsx packages/web/src/components/HangboardingSummary.test.tsx packages/web/src/components/HangboardingSummary.stories.tsx packages/web/src/components/HangboardingDetail.tsx packages/web/src/components/HangboardingDetail.test.tsx packages/web/src/components/HangboardingDetail.stories.tsx packages/web/src/routes/training/climbing.tsx packages/web/src/routes/training/climbing.test.tsx packages/web/src/pages/ActivityDetailPage.tsx packages/web/src/pages/ActivityDetailPage.test.tsx
rtk git commit -m "feat: show Hangboarding details on web"
```

---

### Task 7: Add mobile Hangboarding activity-detail presentation

**Files:**

- Create: `packages/mobile/components/HangboardingSummary.tsx`
- Create: `packages/mobile/components/HangboardingSummary.test.tsx`
- Create: `packages/mobile/components/HangboardingSummary.stories.tsx`
- Create: `packages/mobile/components/HangboardingDetail.tsx`
- Create: `packages/mobile/components/HangboardingDetail.test.tsx`
- Create: `packages/mobile/components/HangboardingDetail.stories.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx`
- Modify: `packages/mobile/app-tests/activity/[id].test.tsx`

**Interfaces:**

- Components consume the same inferred tRPC response shapes as web, adapted
  to React Native layout and existing `colors`, `styles`, and formatting APIs.
- No tests, stories, or helpers are placed under `packages/mobile/app/`.

- [ ] **Step 1: Write failing mobile component and route tests**

Add tests that assert Hangboarding metadata, plan/board fields, interval rows,
empty metadata, and actionable error states. Extend the activity route test to
assert that `activity.hangboardDetails` is enabled only for `hangboard` and
that the screen shows `Hangboarding` and the imported plan name.

- [ ] **Step 2: Run the tests and verify the expected failure**

```bash
rtk pnpm vitest packages/mobile/components/HangboardingSummary.test.tsx packages/mobile/components/HangboardingDetail.test.tsx packages/mobile/app-tests/activity/'[id]'.test.tsx
```

Expected failure: the components and new tRPC mock are missing.

- [ ] **Step 3: Implement the mobile components**

Render the summary metrics in the existing card/grid style and use `SparkLine`
for the server-provided daily duration series. Render detail intervals in a
scroll-safe vertical list with work/rest labels, optional timestamps, and
formatted durations. Show `—` for nullable metrics and preserve server error
messages.

- [ ] **Step 4: Wire the activity detail screen**

Add the `hangboardDetails` query beside the existing activity queries, enabled
only when the loaded activity is canonical `hangboard`. Add a Hangboarding
section after the stats grid and before generic sensor charts. Invalidate the
query with the existing activity recompute/delete invalidations.

- [ ] **Step 5: Run mobile tests and commit**

```bash
rtk pnpm vitest packages/mobile/components/HangboardingSummary.test.tsx packages/mobile/components/HangboardingDetail.test.tsx packages/mobile/app-tests/activity/'[id]'.test.tsx
rtk git add packages/mobile/components/HangboardingSummary.tsx packages/mobile/components/HangboardingSummary.test.tsx packages/mobile/components/HangboardingSummary.stories.tsx packages/mobile/components/HangboardingDetail.tsx packages/mobile/components/HangboardingDetail.test.tsx packages/mobile/components/HangboardingDetail.stories.tsx packages/mobile/app/activity/'[id]'.tsx packages/mobile/app-tests/activity/'[id]'.test.tsx
rtk git commit -m "feat: show Hangboarding details on mobile"
```

---

### Task 8: Full verification and handoff

**Files:**

- Modify only if verification reveals a real defect in the changed behavior.

- [ ] **Step 1: Run changed-file tests**

```bash
rtk pnpm test:changed
rtk pnpm test:changed:all
```

Expected: changed unit and integration suites pass with no skipped Hang Ten
coverage.

- [ ] **Step 2: Run repository quality gates**

```bash
rtk pnpm lint
rtk pnpm typecheck
rtk pnpm lint:analytics-policy
```

Expected: all gates exit zero without raised limits, disabled rules, or
warn-and-continue behavior.

- [ ] **Step 3: Inspect the final diff and working tree**

```bash
rtk git diff HEAD~8..HEAD --check
rtk git status --short
```

Confirm only the Hangboarding implementation, tests, docs, and migrations are
committed. Preserve the pre-existing untracked `paseo.json` unless it was
created by the task.

- [ ] **Step 4: Complete the handoff**

Report the importer commits reused, the new current-branch migration number,
the server contracts, web/mobile surfaces, exact verification commands and
results, and any remaining limitation (Apple Health only supplies the Hang
Ten metadata/segments that were exported). Include the required retrospective
and concrete suggestions for future AGENTS/README/runbook improvements.
