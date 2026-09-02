# Dashboard Speed Implementation Plan
**Goal:** Keep dashboard-critical reads fast without reintroducing broad tRPC batching, ClickHouse fan-out, or request-time raw sensor aggregation.
**Architecture:** Replace SQL-text queue classification with an explicit dashboard priority option on `ActivitySensorStore.query`. Move dashboard overview loading into a shared server service that reads dbt-owned incremental read models, then have web and mobile call that service through their existing routers.
**Tech Stack:** TypeScript, tRPC, Zod, Vitest, ClickHouse, dbt-owned analytics read models, React, React Native/Expo.
## File Structure
- Modify `packages/server/src/repositories/activity-repository.ts`: add a typed `priority?: "dashboard"` query option.
- Modify `packages/server/src/repositories/limited-activity-sensor-store.ts`: route explicit dashboard-priority queries to the dashboard limiter and stop relying on SQL marker heuristics.
- Modify `packages/server/src/repositories/clickhouse-activity-sensor-store.ts`: accept and ignore the new option at the raw client boundary.
- Modify `packages/server/src/repositories/limited-activity-sensor-store.test.ts`: cover explicit priority and regular query behavior.
- Create `packages/server/src/services/dashboard-overview.ts`: shared server dashboard overview loader over `analytics.daily_recovery`, `analytics.daily_sleep`, and `analytics.daily_strain`.
- Create `packages/server/src/services/dashboard-overview.test.ts`: prove the service uses read models with dashboard priority and no raw sensor tables.
- Modify `packages/server/src/routers/mobile-dashboard.ts`: delegate overview reads to the shared service.
- Modify `packages/server/src/routers/mobile-dashboard.test.ts`: preserve current output shape and latency-sensitive query behavior.
- Modify `packages/web/src/lib/trpc.ts` and `packages/web/src/lib/trpc.test.ts`: keep dashboard-critical queries unbatched without adding broad dashboard batch fan-out.
- Modify `packages/mobile/app/_layout.tsx` and `packages/mobile/app/_layout.cleanup.test.tsx`: preserve unbatched mobile dashboard links.
### Task 1: Explicit ClickHouse Dashboard Priority
**Files:**
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/limited-activity-sensor-store.ts`
- Modify: `packages/server/src/repositories/clickhouse-activity-sensor-store.ts`
- Test: `packages/server/src/repositories/limited-activity-sensor-store.test.ts`
- [ ] **Step 1 (RED): Add the failing priority-routing test**
Add this test to `packages/server/src/repositories/limited-activity-sensor-store.test.ts`:
```typescript
it("starts explicitly prioritized dashboard queries while regular work is queued", async () => {
  const events: string[] = [];
  const stream = deferred<StreamPointRow[]>();
  const dashboardRows = deferred<Array<{ value: number }>>();
  const delegate = makeDelegate({
    getStream: vi.fn(() => {
      events.push("stream-started");
      return stream.promise;
    }),
    query: vi.fn(() => {
      events.push("dashboard-started");
      return dashboardRows.promise;
    }),
  });
  const store = new LimitedActivitySensorStore(delegate, 1);
  const streamPromise = store.getStream(makeSensorWindow(), 500);
  await Promise.resolve();
  const dashboardPromise = store.query(
    z.object({ value: z.number() }),
    "SELECT value FROM analytics.some_new_dashboard_table",
    {},
    { priority: "dashboard" },
  );
  for (let microtaskTurn = 0; microtaskTurn < 5; microtaskTurn += 1) {
    await Promise.resolve();
  }
  const dashboardStartedBeforeRegularRelease = events.includes("dashboard-started");
  stream.resolve([]);
  dashboardRows.resolve([{ value: 1 }]);
  await Promise.all([streamPromise, dashboardPromise]);
  expect(dashboardStartedBeforeRegularRelease).toBe(true);
});
```
- [ ] **Step 2 (RED): Run the focused test and verify the expected failure**
```bash
pnpm vitest run --project unit packages/server/src/repositories/limited-activity-sensor-store.test.ts --testNamePattern "explicitly prioritized dashboard"
```
Expected: FAIL because `ActivitySensorStore.query` does not accept an options argument and `LimitedActivitySensorStore` still classifies dashboard queries by SQL text.
- [ ] **Step 3 (GREEN): Add the minimal priority option**
Change the `ActivitySensorStore.query` signature to:
```typescript
query<TSchema extends z.ZodType>(
  schema: TSchema,
  query: string,
  params?: Record<string, unknown>,
  options?: { priority?: "dashboard" },
): Promise<z.infer<TSchema>[]>;
```
In `LimitedActivitySensorStore.query`, replace marker selection with:
```typescript
const limiter =
  options?.priority === "dashboard" ? this.#dashboardLimiter : this.#regularLimiter;
```
Keep `ClickHouseActivitySensorStore.query` behavior identical except for accepting the fourth parameter.
- [ ] **Step 4 (GREEN): Run the priority tests and verify the passing behavior**
```bash
pnpm vitest run --project unit packages/server/src/repositories/limited-activity-sensor-store.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit the focused priority-routing change**
```bash
git add packages/server/src/repositories/activity-repository.ts packages/server/src/repositories/limited-activity-sensor-store.ts packages/server/src/repositories/clickhouse-activity-sensor-store.ts packages/server/src/repositories/limited-activity-sensor-store.test.ts
git commit -m "perf: make dashboard clickhouse priority explicit"
```
### Task 2: Shared Dashboard Overview Service
**Files:**
- Create: `packages/server/src/services/dashboard-overview.ts`
- Test: `packages/server/src/services/dashboard-overview.test.ts`
- Modify: `packages/server/src/routers/mobile-dashboard.ts`
- Test: `packages/server/src/routers/mobile-dashboard.test.ts`
- [ ] **Step 1 (RED): Add the failing service test**
Create `packages/server/src/services/dashboard-overview.test.ts` with:
```typescript
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { loadDashboardOverview } from "./dashboard-overview.ts";
function makeSensorStore(): ActivitySensorStore {
  return {
    query: vi.fn(async (_schema: z.ZodType, queryText: string) => {
      expect(queryText).not.toContain("analytics.deduped_sensor");
      expect(queryText).not.toContain("fitness.metric_stream");
      if (queryText.includes("analytics.daily_recovery")) {
        return [{ date: "2026-06-29", hrv: 62, hrv_score: 70, resting_hr_score: 68, sleep_score: 80, respiratory_rate_score: 75 }];
      }
      if (queryText.includes("analytics.daily_sleep")) {
        return [{ date: "2026-06-29", duration_minutes: 455, deep_minutes: 70, rem_minutes: 95, light_minutes: 260, awake_minutes: 30 }];
      }
      if (queryText.includes("analytics.daily_strain")) {
        return [{ metric_date: "2026-06-29", daily_load: 120 }];
      }
      return [];
    }),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  };
}
describe("loadDashboardOverview", () => {
  it("loads dashboard overview from route-facing read models with dashboard priority", async () => {
    const sensorStore = makeSensorStore();
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-06-29",
      sensorStore,
      userId: "user-1",
    });
    expect(result.latestDate).toBe("2026-06-29");
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("analytics.daily_recovery"),
      expect.any(Object),
      { priority: "dashboard" },
    );
  });
});
```
- [ ] **Step 2 (RED): Run the service test and verify the expected failure**
```bash
pnpm vitest run --project unit packages/server/src/services/dashboard-overview.test.ts
```
Expected: FAIL because `dashboard-overview.ts` does not exist.
- [ ] **Step 3 (GREEN): Implement the service and route delegation**
Create `loadDashboardOverview` with inputs `{ accessWindow, endDate, sensorStore, userId }`. Move only the read-model queries and response mapping currently embedded in `mobileDashboard.dashboard` into the service. Every `sensorStore.query` call in the service must pass `{ priority: "dashboard" }` and must read `analytics.daily_recovery`, `analytics.daily_sleep`, or `analytics.daily_strain`; it must not read `analytics.deduped_sensor`, `analytics.activity_sensor_sample`, or `fitness.metric_stream`.
Update `mobileDashboard.dashboard` to call the service and keep the existing output schema unchanged.
- [ ] **Step 4 (GREEN): Run service and router tests**
```bash
pnpm vitest run --project unit packages/server/src/services/dashboard-overview.test.ts packages/server/src/routers/mobile-dashboard.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit the shared dashboard service change**
```bash
git add packages/server/src/services/dashboard-overview.ts packages/server/src/services/dashboard-overview.test.ts packages/server/src/routers/mobile-dashboard.ts packages/server/src/routers/mobile-dashboard.test.ts
git commit -m "perf: share dashboard overview read model loader"
```
### Task 3: Preserve Unbatched Dashboard Clients
**Files:**
- Modify: `packages/web/src/lib/trpc.test.ts`
- Modify: `packages/web/src/lib/trpc.ts`
- Modify: `packages/mobile/app/_layout.cleanup.test.tsx`
- Modify: `packages/mobile/app/_layout.tsx`
- [ ] **Step 1 (RED): Add failing client regression tests**
In `packages/web/src/lib/trpc.test.ts`, add a test asserting `recovery.readinessScore`, `recovery.workloadRatio`, `recovery.strainTarget`, `sleepNeed.performance`, and the new dashboard-adjacent `sync.dataHealth` query use the `httpLink`, while a non-dashboard query uses the stream batch link:
```typescript
expect(routeLinkFor("recovery.readinessScore")).toBe("httpLink");
expect(routeLinkFor("recovery.workloadRatio")).toBe("httpLink");
expect(routeLinkFor("recovery.strainTarget")).toBe("httpLink");
expect(routeLinkFor("sleepNeed.performance")).toBe("httpLink");
expect(routeLinkFor("sync.dataHealth")).toBe("httpLink");
expect(routeLinkFor("providers.list")).toBe("httpBatchStreamLink");
```
In `packages/mobile/app/_layout.cleanup.test.tsx`, assert `mobileDashboard.dashboard`, `mobileDashboard.recovery`, `mobileDashboard.training`, and `sync.dataHealth` use `httpLink`:
```typescript
expect(routeLinkFor("mobileDashboard.dashboard")).toBe("httpLink");
expect(routeLinkFor("mobileDashboard.recovery")).toBe("httpLink");
expect(routeLinkFor("mobileDashboard.training")).toBe("httpLink");
expect(routeLinkFor("sync.dataHealth")).toBe("httpLink");
```
- [ ] **Step 2 (RED): Run client tests and verify the expected failures**
```bash
pnpm vitest run --project unit packages/web/src/lib/trpc.test.ts
pnpm vitest run --project mobile packages/mobile/app/_layout.cleanup.test.tsx
```
Expected: FAIL because the new `sync.dataHealth` dashboard-readiness route is not yet in the explicit unbatched routing set.
- [ ] **Step 3 (GREEN): Keep only explicit unbatched paths**
Add only `sync.dataHealth` to the existing explicit unbatched route sets. Do not switch the whole dashboard to broad batching, and do not add concurrent client fan-out.
- [ ] **Step 4 (GREEN): Run verification**
```bash
pnpm vitest run --project unit packages/web/src/lib/trpc.test.ts packages/server/src/repositories/limited-activity-sensor-store.test.ts packages/server/src/services/dashboard-overview.test.ts packages/server/src/routers/mobile-dashboard.test.ts
pnpm vitest run --project mobile packages/mobile/app/_layout.cleanup.test.tsx
pnpm tsc --noEmit
```
- [ ] **Step 5 (REFACTOR): Commit the transport-routing lock**
```bash
git add packages/web/src/lib/trpc.ts packages/web/src/lib/trpc.test.ts packages/mobile/app/_layout.tsx packages/mobile/app/_layout.cleanup.test.tsx
git commit -m "test: lock dashboard transport routing"
```
