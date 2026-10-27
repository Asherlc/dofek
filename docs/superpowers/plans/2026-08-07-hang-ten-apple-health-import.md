# Hang Ten Apple Health Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Hang Ten Apple Health workouts as canonical `hangboard` activities with preserved Hang Ten metadata and ordered activity intervals.

**Architecture:** Extend the existing Apple Health import pipeline instead of adding a separate provider. The streaming parser attaches workout metadata, the workout model normalizes Hang Ten metadata into typed fields, and the database insertion layer writes one activity plus idempotent intervals.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres enum migrations, Vitest unit tests, Vitest integration tests with the existing test database helper.

## Global Constraints

- Keep `provider_id = apple_health`; represent Hang Ten through `sourceName` and raw metadata.
- Add `hangboard` as a first-class canonical activity type in the shared training package and database enum.
- Recognize Hang Ten only when the Apple Health export uses `HKWorkoutActivityTypeFunctionalStrengthTraining`, the HealthKit workout brand metadata key contains `Hang Ten`, and `HangTen.PlanName` is present after trimming whitespace. Apple documents the HealthKit functional strength workout type and workout brand metadata key in `HKWorkoutActivityType.functionalStrengthTraining` and `HKMetadataKeyWorkoutBrandName`: https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/functionalstrengthtraining and https://developer.apple.com/documentation/healthkit/hkmetadatakeyworkoutbrandname.
- Store Hang Ten session ID, plan name, board ID, board name, raw segment JSON, and parsed segments in `activity.raw`.
- Insert one `activity_interval` per parsed segment and replace existing intervals on reimport.
- Malformed Hang Ten segment JSON must report a sync error while still importing the workout row.
- Do not add a direct Hang Ten API, direct Hang Ten provider, cloud account sync, or new hangboard-specific database columns.
- Follow TDD: write failing tests before implementation code.

---

## File Structure

- Modify `packages/training/src/training.ts`: add `hangboard` to canonical activity types and labels.
- Modify `packages/training/src/training.test.ts`: prove `hangboard` is canonical and labels as `Hangboard`.
- Modify `src/db/schema/enums.ts`: add `hangboard` to the Drizzle canonical activity type enum.
- Create `drizzle/0071_add_hangboard_activity_type.sql`: add the canonical enum value with `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'hangboard';`.
- Modify `src/providers/apple-health/workouts.ts`: add metadata and Hang Ten segment parsing helpers on `HealthWorkout`.
- Modify `src/providers/apple-health/parsing.test.ts` and `src/providers/apple-health/parsing-extra.test.ts`: cover Hang Ten detection and metadata parsing.
- Modify `src/providers/apple-health/streaming.ts`: collect nested `MetadataEntry` elements for open workouts.
- Modify `src/providers/apple-health/streaming.test.ts`: prove metadata entries are attached to streamed workouts.
- Modify `src/providers/apple-health/db-insertion.ts`: write Hang Ten activity fields, raw payload, and intervals.
- Modify `src/providers/apple-health/db-insertion.test.ts`: unit-test raw payload, external IDs, interval rows, and malformed segment handling.
- Modify `src/providers/apple-health/db-insertion.integration.test.ts`: verify real DB interval replacement.
- Modify `src/providers/apple-health/import.ts`: report malformed Hang Ten segment metadata as non-fatal sync errors.
- Modify `src/providers/apple-health/import.test.ts`: unit-test non-fatal Hang Ten segment metadata sync errors.
- Modify `src/providers/apple-health/import.integration.test.ts`: verify a minimal export creates a `hangboard` activity with intervals.

---

### Task 1: Add Canonical `hangboard` Activity Type

**Files:**
- Modify: `packages/training/src/training.ts`
- Modify: `packages/training/src/training.test.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0071_add_hangboard_activity_type.sql`

**Interfaces:**
- Produces: canonical activity type literal `"hangboard"` usable anywhere `CanonicalActivityType` is accepted.
- Produces: database enum value `fitness.canonical_activity_type = 'hangboard'`.

- [ ] **Step 1: Write the failing shared training tests**

Add assertions in `packages/training/src/training.test.ts`:

```ts
expect(CANONICAL_ACTIVITY_TYPES).toContain("hangboard");
expect(formatActivityTypeLabel("hangboard")).toBe("Hangboard");
```

- [ ] **Step 2: Run training tests to verify failure**

Run: `rtk pnpm vitest packages/training/src/training.test.ts`

Expected: FAIL because `CANONICAL_ACTIVITY_TYPES` does not contain `hangboard`.

- [ ] **Step 3: Add canonical type and label**

In `packages/training/src/training.ts`, add `"hangboard"` near the other climbing/strength-adjacent types in `CANONICAL_ACTIVITY_TYPES`. Add this entry to `ACTIVITY_TYPE_LABELS`:

```ts
hangboard: "Hangboard",
```

- [ ] **Step 4: Add the Drizzle enum value**

In `src/db/schema/enums.ts`, add `"hangboard"` to `canonicalActivityTypeEnum` near `"climbing"` and `"rock_climbing"`.

Create `drizzle/0071_add_hangboard_activity_type.sql`:

```sql
ALTER TYPE fitness.canonical_activity_type ADD VALUE IF NOT EXISTS 'hangboard' AFTER 'climbing';
```

- [ ] **Step 5: Run focused tests**

Run: `rtk pnpm vitest packages/training/src/training.test.ts`

Expected: PASS.

- [ ] **Step 6: Run migration locally**

Run: `rtk pnpm migrate`

Expected: migration succeeds.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/training/src/training.ts packages/training/src/training.test.ts src/db/schema.ts drizzle/0071_add_hangboard_activity_type.sql drizzle/meta/_journal.json
rtk git commit -m "feat: add hangboard activity type"
rtk git push
```

---

### Task 2: Parse Hang Ten Workout Metadata

**Files:**
- Modify: `src/providers/apple-health/workouts.ts`
- Modify: `src/providers/apple-health/parsing.test.ts`
- Modify: `src/providers/apple-health/parsing-extra.test.ts`
- Modify: `src/providers/apple-health/streaming.ts`
- Modify: `src/providers/apple-health/streaming.test.ts`

**Interfaces:**
- Consumes: `CanonicalActivityType` includes `"hangboard"` from Task 1.
- Produces: `HealthWorkout.metadata?: Record<string, string>`.
- Produces: `HealthWorkout.hangTen?: HangTenWorkoutMetadata`.
- Produces: `applyWorkoutMetadata(workout: HealthWorkout, metadata: Record<string, string>): HealthWorkout`.
- Produces:

```ts
export interface HangTenActivitySegment {
  stepID: string;
  stepNumber: number;
  kind: "work" | "rest";
  holdIDs: string[];
  holdType?: string;
  sizeMillimeters?: number;
  durationSeconds?: number;
}

export interface HangTenWorkoutMetadata {
  sessionId?: string;
  planName: string;
  boardId?: string;
  boardName?: string;
  rawActivitySegments?: string;
  activitySegments?: HangTenActivitySegment[];
  activitySegmentsError?: string;
}
```

- [ ] **Step 1: Write failing workout parser tests**

In `src/providers/apple-health/parsing.test.ts`, add a test that calls `parseWorkout` with a functional strength workout and metadata:

```ts
const result = parseWorkout(
  {
    workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
    duration: "10",
    durationUnit: "min",
    startDate: "2026-08-07 07:00:00 -0700",
    endDate: "2026-08-07 07:10:00 -0700",
  },
  {
    HKMetadataKeyWorkoutBrandName: "Hang Ten",
    "HangTen.PlanName": "7/3 Repeaters",
    "HangTen.SessionID": "11111111-1111-4111-8111-111111111111",
    "HangTen.BoardID": "metolius-compact-ii",
    "HangTen.BoardName": "Metolius Compact II",
    "HangTen.ActivitySegments":
      '{"segments":[{"stepID":"step-1","stepNumber":1,"kind":"work","holdIDs":["edge-19"],"holdType":"edge","sizeMillimeters":19,"durationSeconds":7}],"version":1}',
  },
);

expect(result.activityType).toBe("hangboard");
expect(result.sourceName).toBe("Hang Ten");
expect(result.hangTen).toMatchObject({
  sessionId: "11111111-1111-4111-8111-111111111111",
  planName: "7/3 Repeaters",
  boardId: "metolius-compact-ii",
  boardName: "Metolius Compact II",
});
expect(result.hangTen?.activitySegments).toEqual([
  {
    stepID: "step-1",
    stepNumber: 1,
    kind: "work",
    holdIDs: ["edge-19"],
    holdType: "edge",
    sizeMillimeters: 19,
    durationSeconds: 7,
  },
]);
```

In `src/providers/apple-health/parsing-extra.test.ts`, add a malformed JSON case:

```ts
const result = parseWorkout(
  {
    workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
    duration: "10",
    durationUnit: "min",
    startDate: "2026-08-07 07:00:00 -0700",
    endDate: "2026-08-07 07:10:00 -0700",
  },
  {
    HKMetadataKeyWorkoutBrandName: "Hang Ten",
    "HangTen.PlanName": "Max Hangs",
    "HangTen.ActivitySegments": "{not json",
  },
);

expect(result.activityType).toBe("hangboard");
expect(result.hangTen?.rawActivitySegments).toBe("{not json");
expect(result.hangTen?.activitySegments).toBeUndefined();
expect(result.hangTen?.activitySegmentsError).toContain("Invalid Hang Ten activity segments JSON");
```

- [ ] **Step 2: Run parser tests to verify failure**

Run: `rtk pnpm vitest src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts`

Expected: FAIL because `parseWorkout` does not accept metadata or produce `hangTen`.

- [ ] **Step 3: Implement typed metadata parsing**

In `src/providers/apple-health/workouts.ts`, import Zod and update the function signature:

```ts
import { z } from "zod";

export function parseWorkout(
  attrs: Record<string, string>,
  metadata: Record<string, string> = {},
): HealthWorkout
```

Add the interfaces from this task. Add helpers:

```ts
function trimmedMetadataValue(metadata: Record<string, string>, key: string): string | undefined {
  const value = metadata[key]?.trim();
  return value ? value : undefined;
}

const hangTenActivityMetadataSchema = z.object({
  version: z.number().optional(),
  segments: z.array(
    z.object({
      stepID: z.string(),
      stepNumber: z.number(),
      kind: z.enum(["work", "rest"]),
      holdIDs: z.array(z.string()),
      holdType: z.string().optional(),
      sizeMillimeters: z.number().optional(),
      durationSeconds: z.number().optional(),
    }),
  ),
});

function parseHangTenActivitySegments(raw: string): {
  segments?: HangTenActivitySegment[];
  error?: string;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = hangTenActivityMetadataSchema.safeParse(parsed);
    if (!result.success) {
      return { error: "Invalid Hang Ten activity segments JSON: segment metadata has invalid fields" };
    }
    return { segments: result.data.segments };
  } catch {
    return { error: "Invalid Hang Ten activity segments JSON: could not parse JSON" };
  }
}
```

When metadata identifies Hang Ten, return `activityType: "hangboard"`, `sourceName: "Hang Ten"`, and `hangTen`. Export:

```ts
export function applyWorkoutMetadata(
  workout: HealthWorkout,
  metadata: Record<string, string>,
): HealthWorkout {
  return {
    ...workout,
    metadata,
    ...hangTenWorkoutOverrides(workout.activityType, metadata),
  };
}
```

`hangTenWorkoutOverrides()` is a private helper that returns `{ activityType: "hangboard", sourceName: "Hang Ten", hangTen }` only for recognized Hang Ten metadata, otherwise `{}`.

- [ ] **Step 4: Write failing streaming metadata test**

In `src/providers/apple-health/streaming.test.ts`, add:

```ts
it("attaches MetadataEntry values to workouts", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Workout workoutActivityType="HKWorkoutActivityTypeFunctionalStrengthTraining"
  duration="10" durationUnit="min"
  sourceName="Hang Ten"
  startDate="2026-08-07 07:00:00 -0700"
  endDate="2026-08-07 07:10:00 -0700">
  <MetadataEntry key="HKMetadataKeyWorkoutBrandName" value="Hang Ten"/>
  <MetadataEntry key="HangTen.PlanName" value="7/3 Repeaters"/>
  <MetadataEntry key="HangTen.ActivitySegments" value="{&quot;segments&quot;:[],&quot;version&quot;:1}"/>
 </Workout>
</HealthData>`;
  const path = writeXml("hang-ten-workout.xml", xml);

  const workouts: HealthWorkout[] = [];
  await streamHealthExport(path, new Date("2020-01-01"), {
    onRecordBatch: async () => {},
    onSleepBatch: async () => {},
    onWorkoutBatch: async (batch) => {
      workouts.push(...batch);
    },
  });

  expect(workouts[0]?.activityType).toBe("hangboard");
  expect(workouts[0]?.hangTen?.planName).toBe("7/3 Repeaters");
  expect(workouts[0]?.metadata?.["HangTen.PlanName"]).toBe("7/3 Repeaters");
});
```

- [ ] **Step 5: Implement streaming metadata collection**

In `src/providers/apple-health/streaming.ts`, add:

```ts
let currentWorkoutMetadata: Record<string, string> = {};
```

When opening `Workout`, reset `currentWorkoutMetadata = {}`. When opening `MetadataEntry` while `currentWorkout` exists:

```ts
if (node.name === "MetadataEntry" && currentWorkout && attrs.key && attrs.value !== undefined) {
  currentWorkoutMetadata[attrs.key] = attrs.value;
}
```

Before flushing a workout, call:

```ts
currentWorkout = applyWorkoutMetadata(currentWorkout, currentWorkoutMetadata);
```

Do this before `enrichWorkoutFromStats(currentWorkout, currentWorkoutStats)` so heart-rate and calorie enrichment still applies to the Hang Ten workout row.

- [ ] **Step 6: Run focused parser and streaming tests**

Run: `rtk pnpm vitest src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts src/providers/apple-health/streaming.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add src/providers/apple-health/workouts.ts src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts src/providers/apple-health/streaming.ts src/providers/apple-health/streaming.test.ts
rtk git commit -m "feat: parse Hang Ten Apple Health metadata"
rtk git push
```

---

### Task 3: Insert Hang Ten Raw Payloads and Intervals

**Files:**
- Modify: `src/providers/apple-health/db-insertion.ts`
- Modify: `src/providers/apple-health/db-insertion.test.ts`
- Modify: `src/providers/apple-health/db-insertion.integration.test.ts`

**Interfaces:**
- Consumes: `HealthWorkout.hangTen?: HangTenWorkoutMetadata` from Task 2.
- Produces:

```ts
export function hangTenIntervalLabel(segment: HangTenActivitySegment): string;
export function buildHangTenIntervals(
  activityId: string,
  workout: HealthWorkout,
): (typeof activityInterval.$inferInsert)[];
```

- [ ] **Step 1: Write failing unit tests for raw rows and external IDs**

In `src/providers/apple-health/db-insertion.test.ts`, add:

```ts
it("uses Hang Ten session metadata for hangboard activity rows", async () => {
  const start = new Date("2026-08-07T14:00:00Z");
  const { db, capture } = createMockDb([{ id: "act-1" }]);

  await upsertWorkoutBatch(db, "apple_health", [
    makeWorkout({
      activityType: "hangboard",
      sourceName: "Hang Ten",
      startDate: start,
      hangTen: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        planName: "7/3 Repeaters",
        boardId: "metolius-compact-ii",
        boardName: "Metolius Compact II",
        rawActivitySegments: '{"segments":[],"version":1}',
        activitySegments: [],
      },
    }),
  ]);

  expect(capture.values[0]?.[0]).toMatchObject({
    providerId: "apple_health",
    externalId: "ah:workout:11111111-1111-4111-8111-111111111111",
    activityType: "hangboard",
    name: "7/3 Repeaters",
    sourceName: "Hang Ten",
    raw: {
      durationSeconds: 1800,
      hangTen: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        planName: "7/3 Repeaters",
        boardId: "metolius-compact-ii",
        boardName: "Metolius Compact II",
        rawActivitySegments: '{"segments":[],"version":1}',
        activitySegments: [],
      },
    },
  });
});
```

- [ ] **Step 2: Write failing unit tests for interval labels and times**

Add:

```ts
it("builds Hang Ten intervals with labels and cumulative times", async () => {
  const start = new Date("2026-08-07T14:00:00Z");
  const { db, capture } = createMockDb([{ id: "act-1" }]);

  await upsertWorkoutBatch(db, "apple_health", [
    makeWorkout({
      activityType: "hangboard",
      sourceName: "Hang Ten",
      startDate: start,
      endDate: new Date("2026-08-07T14:01:00Z"),
      hangTen: {
        planName: "Repeaters",
        activitySegments: [
          {
            stepID: "step-1",
            stepNumber: 1,
            kind: "work",
            holdIDs: ["edge-19"],
            holdType: "edge",
            sizeMillimeters: 19,
            durationSeconds: 7,
          },
          {
            stepID: "step-1-rest",
            stepNumber: 1,
            kind: "rest",
            holdIDs: [],
            durationSeconds: 3,
          },
          {
            stepID: "step-2",
            stepNumber: 2,
            kind: "work",
            holdIDs: ["jug"],
          },
        ],
      },
    }),
  ]);

  expect(capture.values[1]).toEqual([
    expect.objectContaining({
      activityId: "act-1",
      intervalIndex: 0,
      label: "Step 1: 19 mm edge",
      intervalType: "work",
      startedAt: start,
      endedAt: new Date("2026-08-07T14:00:07Z"),
    }),
    expect.objectContaining({
      activityId: "act-1",
      intervalIndex: 1,
      label: "Step 1: Rest",
      intervalType: "rest",
      startedAt: new Date("2026-08-07T14:00:07Z"),
      endedAt: new Date("2026-08-07T14:00:10Z"),
    }),
    expect.objectContaining({
      activityId: "act-1",
      intervalIndex: 2,
      label: "Step 2: Work",
      intervalType: "work",
      startedAt: new Date("2026-08-07T14:00:10Z"),
      endedAt: undefined,
    }),
  ]);
});
```

- [ ] **Step 3: Run unit tests to verify failure**

Run: `rtk pnpm vitest src/providers/apple-health/db-insertion.test.ts`

Expected: FAIL because `hangTen` is ignored and no intervals are inserted.

- [ ] **Step 4: Implement raw payload and external ID helpers**

In `src/providers/apple-health/db-insertion.ts`, import `activityInterval` and `type HangTenActivitySegment`.

Add:

```ts
function workoutExternalId(workout: HealthWorkout): string {
  return workout.hangTen?.sessionId
    ? `ah:workout:${workout.hangTen.sessionId}`
    : `ah:workout:${workout.startDate.toISOString()}`;
}

function workoutName(workout: HealthWorkout): string {
  return workout.hangTen?.planName ?? workout.activityType;
}

function workoutRawPayload(workout: HealthWorkout): Record<string, unknown> {
  const raw: Record<string, unknown> = { durationSeconds: workout.durationSeconds };
  if (workout.distanceMeters !== undefined) raw.distanceMeters = workout.distanceMeters;
  if (workout.avgHeartRate !== undefined) raw.avgHeartRate = workout.avgHeartRate;
  if (workout.maxHeartRate !== undefined) raw.maxHeartRate = workout.maxHeartRate;
  if (workout.hangTen) raw.hangTen = workout.hangTen;
  return raw;
}
```

Use these helpers in the activity insert rows and dedup map.

- [ ] **Step 5: Implement interval helpers and insertion**

Add:

```ts
export function hangTenIntervalLabel(segment: HangTenActivitySegment): string {
  if (segment.kind === "rest") return `Step ${segment.stepNumber}: Rest`;
  if (segment.sizeMillimeters !== undefined && segment.holdType) {
    return `Step ${segment.stepNumber}: ${segment.sizeMillimeters} mm ${segment.holdType}`;
  }
  if (segment.holdType) return `Step ${segment.stepNumber}: ${segment.holdType}`;
  return `Step ${segment.stepNumber}: Work`;
}

export function buildHangTenIntervals(
  activityId: string,
  workout: HealthWorkout,
): (typeof activityInterval.$inferInsert)[] {
  const segments = workout.hangTen?.activitySegments;
  if (!segments || segments.length === 0) return [];
  const rows: (typeof activityInterval.$inferInsert)[] = [];
  let cursor: Date | null = workout.startDate;
  for (const [index, segment] of segments.entries()) {
    const startedAt = cursor ?? workout.startDate;
    const endedAt =
      cursor && segment.durationSeconds !== undefined
        ? new Date(cursor.getTime() + segment.durationSeconds * 1000)
        : undefined;
    rows.push({
      activityId,
      intervalIndex: index,
      label: hangTenIntervalLabel(segment),
      intervalType: segment.kind,
      startedAt,
      endedAt,
    });
    cursor = endedAt ?? null;
  }
  return rows;
}
```

After activity inserts return IDs, collect intervals for Hang Ten workouts. Delete existing intervals for each returned Hang Ten activity, then insert new interval rows:

```ts
await db.delete(activityInterval).where(eq(activityInterval.activityId, activityId));
```

Insert intervals only when `buildHangTenIntervals()` returns rows.

- [ ] **Step 6: Preserve malformed segment parse errors in raw payload**

Ensure `workoutRawPayload()` includes:

```ts
if (workout.hangTen?.activitySegmentsError) {
  raw.hangTen = workout.hangTen;
}
```

The parse error is stored with the workout row. No interval rows are inserted when `activitySegments` is absent.

- [ ] **Step 7: Write failing integration test for idempotent interval replacement**

In `src/providers/apple-health/db-insertion.integration.test.ts`, add a test that imports one Hang Ten workout twice with the same session ID and two segments. After the second import, query `schema.activityInterval` for that activity and assert exactly two rows exist with labels `Step 1: 19 mm edge` and `Step 1: Rest`.

- [ ] **Step 8: Run integration dependencies and focused tests**

Run:

```bash
rtk pnpm test:integration -- src/providers/apple-health/db-insertion.integration.test.ts
rtk pnpm vitest run --project unit src/providers/apple-health/db-insertion.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
rtk git add src/providers/apple-health/db-insertion.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/db-insertion.integration.test.ts
rtk git commit -m "feat: store Hang Ten workout intervals"
rtk git push
```

---

### Task 4: Verify End-to-End Apple Health Import

**Files:**
- Modify: `src/providers/apple-health/import.ts`
- Modify: `src/providers/apple-health/import.test.ts`
- Modify: `src/providers/apple-health/import.integration.test.ts`

**Interfaces:**
- Consumes: `parseWorkout()` Hang Ten metadata behavior from Task 2.
- Consumes: `upsertWorkoutBatch()` Hang Ten insertion behavior from Task 3.
- Produces: `runImport()` appends a non-fatal `SyncError` for each workout with `hangTen.activitySegmentsError`.
- Produces: end-to-end confidence that Apple Health export XML creates a `hangboard` activity and intervals.

- [ ] **Step 1: Write failing non-fatal sync error unit test**

In `src/providers/apple-health/import.test.ts`, update the existing `streamHealthExport` mock test coverage for `runImport()` or add a new case that invokes the captured `onWorkoutBatch` handler with:

```ts
[
  {
    activityType: "hangboard",
    sourceName: "Hang Ten",
    durationSeconds: 600,
    startDate: new Date("2026-08-07T14:00:00Z"),
    endDate: new Date("2026-08-07T14:10:00Z"),
    hangTen: {
      planName: "Max Hangs",
      rawActivitySegments: "{not json",
      activitySegmentsError: "Invalid Hang Ten activity segments JSON: could not parse JSON",
    },
  },
]
```

Assert the returned `SyncResult` includes:

```ts
expect(result.errors).toEqual([
  expect.objectContaining({
    externalId: "ah:workout:2026-08-07T14:00:00.000Z",
    message: "Invalid Hang Ten activity segments JSON: could not parse JSON",
  }),
]);
```

- [ ] **Step 2: Implement non-fatal sync error reporting**

In `src/providers/apple-health/import.ts`, add a helper:

```ts
function collectWorkoutImportErrors(workouts: HealthWorkout[]): SyncError[] {
  return workouts.flatMap((workout) => {
    const message = workout.hangTen?.activitySegmentsError;
    if (!message) return [];
    return [
      {
        message,
        externalId: workout.hangTen?.sessionId
          ? `ah:workout:${workout.hangTen.sessionId}`
          : `ah:workout:${workout.startDate.toISOString()}`,
      },
    ];
  });
}
```

Inside the existing `onWorkoutBatch` callback, after `upsertWorkoutBatch()` succeeds, append:

```ts
errors.push(...collectWorkoutImportErrors(workouts));
```

- [ ] **Step 3: Write failing end-to-end import test**

In `src/providers/apple-health/import.integration.test.ts`, add an XML fixture containing:

```xml
<Workout workoutActivityType="HKWorkoutActivityTypeFunctionalStrengthTraining"
 duration="10" durationUnit="min"
 sourceName="Hang Ten"
 startDate="2026-08-07 07:00:00 -0700"
 endDate="2026-08-07 07:10:00 -0700">
 <MetadataEntry key="HKMetadataKeyWorkoutBrandName" value="Hang Ten"/>
 <MetadataEntry key="HangTen.PlanName" value="7/3 Repeaters"/>
 <MetadataEntry key="HangTen.SessionID" value="11111111-1111-4111-8111-111111111111"/>
 <MetadataEntry key="HangTen.BoardID" value="metolius-compact-ii"/>
 <MetadataEntry key="HangTen.BoardName" value="Metolius Compact II"/>
 <MetadataEntry key="HangTen.ActivitySegments" value="{&quot;segments&quot;:[{&quot;stepID&quot;:&quot;step-1&quot;,&quot;stepNumber&quot;:1,&quot;kind&quot;:&quot;work&quot;,&quot;holdIDs&quot;:[&quot;edge-19&quot;],&quot;holdType&quot;:&quot;edge&quot;,&quot;sizeMillimeters&quot;:19,&quot;durationSeconds&quot;:7},{&quot;stepID&quot;:&quot;step-1-rest&quot;,&quot;stepNumber&quot;:1,&quot;kind&quot;:&quot;rest&quot;,&quot;holdIDs&quot;:[],&quot;durationSeconds&quot;:3}],&quot;version&quot;:1}"/>
</Workout>
```

After `importAppleHealthFile()`, query `schema.activity` and `schema.activityInterval`. Assert:

```ts
expect(hangboard?.activityType).toBe("hangboard");
expect(hangboard?.name).toBe("7/3 Repeaters");
expect(hangboard?.sourceName).toBe("Hang Ten");
expect(hangboard?.externalId).toBe("ah:workout:11111111-1111-4111-8111-111111111111");
expect(hangboard?.raw).toMatchObject({
  hangTen: {
    planName: "7/3 Repeaters",
    boardId: "metolius-compact-ii",
    boardName: "Metolius Compact II",
  },
});
expect(intervals.map((interval) => interval.label)).toEqual([
  "Step 1: 19 mm edge",
  "Step 1: Rest",
]);
```

- [ ] **Step 4: Run end-to-end test to verify failure or pass against previous tasks**

Run:

```bash
rtk pnpm compose -- up -d db redis
rtk pnpm compose -- ps db redis
rtk pnpm test:integration -- src/providers/apple-health/import.integration.test.ts
```

Expected before implementation: FAIL. Expected after Tasks 1-3: PASS.

- [ ] **Step 5: Apply exact end-to-end corrections if needed**

If XML entity decoding leaves escaped JSON in metadata, change the streaming metadata assignment to store SAX's decoded `attrs.value` string directly:

```ts
currentWorkoutMetadata[attrs.key] = attrs.value;
```

If the activity query returns multiple rows, query by the exact Hang Ten external ID:

```ts
const hangboard = activities.find(
  (activityRow) =>
    activityRow.externalId === "ah:workout:11111111-1111-4111-8111-111111111111",
);
```

- [ ] **Step 6: Run all focused Apple Health and training tests**

Run:

```bash
rtk pnpm vitest packages/training/src/training.test.ts src/providers/apple-health/parsing.test.ts src/providers/apple-health/parsing-extra.test.ts src/providers/apple-health/streaming.test.ts src/providers/apple-health/db-insertion.test.ts
rtk pnpm test:integration -- src/providers/apple-health/db-insertion.integration.test.ts src/providers/apple-health/import.integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run changed tests and typecheck**

Run:

```bash
rtk pnpm test:changed
rtk pnpm tsc --noEmit
rtk pnpm --dir packages/server tsc --noEmit
rtk pnpm --dir packages/web tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add src/providers/apple-health/import.ts src/providers/apple-health/import.test.ts src/providers/apple-health/import.integration.test.ts
rtk git commit -m "test: cover Hang Ten Apple Health import"
rtk git push
```

---

## Final Verification

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm test:changed`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk git status --short`.
- [ ] Summarize the root behavior change, validation evidence, and any residual risk.
