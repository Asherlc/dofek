# Activity Overview Partial Measurements Implementation Plan

> **For implementers:** Work through this plan task-by-task and use the
> checkbox (`- [ ]`) syntax to track completed steps.

**Goal:** Expose recorded distance and elevation totals for partially measured activity periods and compare those partial totals across periods.

**Architecture:** Keep the existing ClickHouse aggregate query and API contract. Change the server repository mapper to use the measurement count to distinguish “no values recorded” from “some values recorded,” allowing the existing web and mobile renderers and comparison formatter to display the server-provided partial totals.

**Tech Stack:** TypeScript, Vitest, Zod-validated ClickHouse repository results, React web, Expo/React Native mobile, pnpm.

## Global Constraints

- Metric values and comparison magnitudes remain server-computed; clients only render and unit-format them.
- A total is available when at least one activity has a measurement; missing activities contribute nothing to the total.
- Measured numeric zero remains available and renders as zero.
- A period with no measurements remains unavailable with the existing server-authored reason.
- Partial current and previous totals are compared when both periods have at least one measurement.
- Do not add coverage fields, coverage labels, schema changes, ingestion changes, read-model changes, or client-side aggregation.
- Preserve web/mobile parity by adding equivalent regression coverage for both clients.
- Do not modify unrelated existing work, including the untracked `.nx/` directory.

---

### Task 1: Expose partial totals and compare them in the repository

**Files:**
- Modify: `packages/server/src/repositories/activities-calendar-repository.test.ts` around the existing partial-overview and comparison cases.
- Modify: `packages/server/src/repositories/activities-calendar-repository.ts` around `overviewMeasurement()` and `overviewPeriodFromRow()`.

**Interfaces:**
- Consumes: `overviewRowSchema` fields `current_total_distance_meters`, `current_total_elevation_gain_m`, `current_distance_measurement_count`, and `current_elevation_measurement_count`, plus the corresponding previous-period fields.
- Produces: the existing `ActivityOverview` shape with numeric partial totals and `{ status: "available" }` states when measurement count is greater than zero.

- [ ] **Step 1: Rewrite the existing partial-total test as the failing desired behavior**

Rename `does not report partial overview totals as available` to
`reports partial overview totals as available`. Keep its two current-period
activities, with distance measured for one activity and elevation measured for
both, then change the expectation to:

```ts
expect(result).toMatchObject({
  activityCount: 2,
  totalDistanceMeters: 5000,
  totalDistanceState: { status: "available" },
  totalElevationGainM: 100,
  totalElevationState: { status: "available" },
});
```

Keep the existing previous period empty so the test also proves that a current
partial value does not make an unavailable previous comparison appear
available.

- [ ] **Step 2: Add a failing partial-to-partial comparison test**

Add a repository test with two current activities and two previous activities.
Return these overview-row values from the mocked sensor store:

```ts
{
  current_activity_count: 2,
  current_total_minutes: 120,
  current_total_distance_meters: 7500,
  current_total_elevation_gain_m: 150,
  current_distance_measurement_count: 1,
  current_elevation_measurement_count: 1,
  previous_activity_count: 2,
  previous_total_minutes: 90,
  previous_total_distance_meters: 5000,
  previous_total_elevation_gain_m: 100,
  previous_distance_measurement_count: 1,
  previous_elevation_measurement_count: 1,
}
```

Assert that both period totals are available and that the comparison contains
`totalDistanceMeters: { magnitude: 2500, trend: "higher", state: { status: "available" } }`
and
`totalElevationGainM: { magnitude: 50, trend: "higher", state: { status: "available" } }`.

- [ ] **Step 3: Run the repository tests and verify the red failure**

Run:

```bash
pnpm exec vitest run --project unit packages/server/src/repositories/activities-calendar-repository.test.ts
```

Expected: the new partial-total expectation fails because
`overviewPeriodFromRow()` currently nulls any sum whose measurement count is
less than the activity count. The partial-to-partial comparison also reports
an unavailable state for the same reason.

- [ ] **Step 4: Implement the minimal availability mapping**

In `overviewPeriodFromRow()`, replace the complete-coverage checks with
measurement-presence checks:

```ts
const distanceHasMeasurement = distanceMeasurementCount > 0;
const elevationHasMeasurement = elevationMeasurementCount > 0;

return {
  activityCount,
  totalMinutes,
  totalDistance: overviewMeasurement(
    "Distance",
    distanceHasMeasurement ? roundNullableMetric(totalDistanceMeters) : null,
    distanceHasMeasurement,
  ),
  totalElevation: overviewMeasurement(
    "Elevation gain",
    elevationHasMeasurement ? roundNullableMetric(totalElevationGainM) : null,
    elevationHasMeasurement,
  ),
};
```

Keep `createMeasurementChange()` unchanged: once both period measurements are
available, its existing subtraction and trend logic compares the partial
totals. Preserve the existing unavailable wording for periods with zero
measurements and preserve the separate measured-zero test.

- [ ] **Step 5: Run the repository tests and verify green**

Run the same focused Vitest command from Step 3. Expected: all tests in
`activities-calendar-repository.test.ts` pass, including unavailable periods,
measured zeros, complete totals, partial totals, and partial comparisons.

- [ ] **Step 6: Commit the server behavior and tests**

```bash
git add packages/server/src/repositories/activities-calendar-repository.ts packages/server/src/repositories/activities-calendar-repository.test.ts
git commit -m "fix: compare partial activity measurements"
```

### Task 2: Add web and mobile rendering parity coverage

**Files:**
- Modify: `packages/web/src/pages/ActivitiesPage.test.tsx` next to the existing unavailable-versus-zero overview test.
- Modify: `packages/mobile/app-tests/(tabs)/activities.test.tsx` next to the equivalent unavailable-versus-zero overview test.
- No production client files are expected to change; both clients already render available server-provided metric values and comparison magnitudes.

**Interfaces:**
- Consumes: the existing `ActivityOverviewData` contract with numeric totals, `{ status: "available" }` states, and `ActivityOverviewComparison` values.
- Produces: equivalent web and mobile regression coverage proving partial server output is visible to users.

- [ ] **Step 1: Add the web contract test fixture**

Add a test that sets `mockOverviewQuery.data` to a partially measured server
response:

```ts
{
  activityCount: 4,
  totalMinutes: 280,
  totalDistanceMeters: 12500,
  totalDistanceState: { status: "available" },
  totalElevationGainM: 180,
  totalElevationState: { status: "available" },
  activityTypes: ["running", "cycling"],
  comparison: {
    periodLabel: "previous 4 weeks",
    activityCount: { magnitude: 1, trend: "higher" },
    totalMinutes: { magnitude: 60, trend: "higher" },
    totalDistanceMeters: { magnitude: 2500, trend: "higher", state: { status: "available" } },
    totalElevationGainM: { magnitude: 50, trend: "higher", state: { status: "available" } },
  },
}
```

Render `ActivitiesPage` and assert `12.5 km`, `180 m`, `2.5 km more vs previous 4 weeks`,
and `50 m more vs previous 4 weeks`. Assert the unavailable copy is absent.
This test validates that the existing web renderer accepts and displays the
partial server contract.

- [ ] **Step 2: Run the focused web test**

Run:

```bash
pnpm exec vitest run --project unit packages/web/src/pages/ActivitiesPage.test.tsx
```

Expected: the web test passes after Task 1 because the renderer already
formats available values and comparison magnitudes; if it fails, fix only the
test fixture or the existing rendering contract that prevents server-provided
values from appearing.

- [ ] **Step 3: Add the equivalent mobile test fixture**

Add the same partial overview values and comparison values to the mobile
overview test, render `ActivitiesScreen`, and assert `12.5 km`, `180 m`,
`2.5 km more vs previous 4 weeks`, and `50 m more vs previous 4 weeks`. Assert
the unavailable copy is absent. Keep the assertions equivalent to the web
test while using the mobile testing-library queries already established in the
file.

- [ ] **Step 4: Run the focused mobile test**

Run:

```bash
pnpm exec vitest run --project mobile 'packages/mobile/app-tests/(tabs)/activities.test.tsx'
```

Expected: the mobile test passes with the existing renderer and confirms
web/mobile parity for partial values and comparisons.

- [ ] **Step 5: Commit the parity coverage**

```bash
git add packages/web/src/pages/ActivitiesPage.test.tsx packages/mobile/app-tests/\(tabs\)/activities.test.tsx
git commit -m "test: cover partial activity overview metrics"
```

### Task 3: Run final focused verification and review the diff

**Files:**
- Review only: the two committed implementation/test changes and the approved design/plan documents.

**Interfaces:**
- Consumes: the repository behavior and web/mobile regression coverage from Tasks 1–2.
- Produces: verified source and test changes with no unrelated modifications.

- [ ] **Step 1: Run all focused unit tests together**

Run:

```bash
pnpm exec vitest run --project unit \
  packages/server/src/repositories/activities-calendar-repository.test.ts \
  packages/format/src/activity-overview.test.ts \
  packages/web/src/pages/ActivitiesPage.test.tsx
pnpm exec vitest run --project mobile 'packages/mobile/app-tests/(tabs)/activities.test.tsx'
```

Expected: both commands exit successfully with zero failed tests.

- [ ] **Step 2: Run type checking and lint on changed packages**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit successfully without modifying thresholds,
disabling rules, or adding ignores.

- [ ] **Step 3: Review the final diff and status**

Run:

```bash
git diff HEAD~2..HEAD --check
git diff HEAD~2..HEAD --stat
git status --short
```

Confirm the changed source and test files are limited to the repository mapping
and web/mobile parity coverage. Review the already committed design and plan
documents separately. The unrelated untracked `.nx/` directory must remain
untouched.

- [ ] **Step 4: Complete the retrospective handoff**

Report the one-sentence root cause, the direct mapping fix, the focused test
commands and results, and whether full typecheck/lint passed. Mention that no
resilience knob, schema change, or backfill was needed. Suggest any useful
future `AGENTS.md`, `README.md`, or runbook wording changes separately rather
than adding unrelated documentation to this change.
