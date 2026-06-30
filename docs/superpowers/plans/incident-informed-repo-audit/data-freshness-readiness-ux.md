# Data Freshness Readiness UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show users whether dashboard, activities, and provider data is missing, stale, syncing, or blocked instead of rendering unexplained empty states.

**Architecture:** Extend the existing `sync.dataHealth` route from row counts into a typed readiness snapshot that combines Postgres raw data counts, ClickHouse CDC mirror freshness, dbt read-model freshness, and active sync state. Render the same server-computed state on web and mobile; clients only display labels, colors, and layout.

**Tech Stack:** TypeScript, tRPC, Zod, Drizzle, Vitest, React, React Native/Expo, Storybook.

---

## File Structure

- Modify `packages/server/src/routers/sync.ts`: replace numeric-only `dataHealth` output with structured readiness/freshness details.
- Modify `packages/server/src/routers/sync.test.ts`: cover missing, stale CDC, stale dbt, active sync, and healthy states.
- Create `packages/web/src/components/DataReadinessBanner.tsx`: web readiness banner.
- Create `packages/web/src/components/DataReadinessBanner.test.tsx`.
- Create `packages/web/src/components/DataReadinessBanner.stories.tsx`.
- Modify `packages/web/src/pages/Dashboard.tsx`, `packages/web/src/pages/ActivitiesPage.tsx`, and `packages/web/src/pages/ProviderDetailPage.tsx`: render the banner from `sync.dataHealth`.
- Create `packages/mobile/components/DataReadinessBanner.tsx`.
- Create `packages/mobile/components/DataReadinessBanner.test.tsx`.
- Create `packages/mobile/components/DataReadinessBanner.stories.tsx`.
- Modify `packages/mobile/app/(tabs)/index.tsx`, `packages/mobile/app/(tabs)/activities.tsx`, and `packages/mobile/app/providers/[id].tsx`: render the same readiness state.

### Task 1: Structured Server Readiness Snapshot

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`

- [ ] **Step 1: Add the failing server test**

Add this test in `describe("syncRouter", ...)`:

```typescript
it("returns structured data health when raw data is missing", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ count: 0 }])
    .mockResolvedValueOnce([{ count: 0 }])
    .mockResolvedValueOnce([{ count: 0 }]);
  mockGetJobs.mockResolvedValue([]);
  const caller = createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.dataHealth();

  expect(result.overallStatus).toBe("missing");
  expect(result.datasets).toEqual([
    expect.objectContaining({
      key: "dailyMetrics",
      rawRows: 0,
      status: "missing",
      message: "No daily metric data has synced yet.",
    }),
    expect.objectContaining({ key: "sleep", rawRows: 0, status: "missing" }),
    expect.objectContaining({ key: "activity", rawRows: 0, status: "missing" }),
  ]);
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "structured data health"
```

Expected: FAIL because `dataHealth` currently returns `{ dailyMetrics, sleep, activity }` numeric counts.

- [ ] **Step 3: Implement the output schema and mapping**

Add a `dataHealthOutputSchema` with:

```typescript
const dataHealthOutputSchema = z.object({
  overallStatus: z.enum(["healthy", "syncing", "stale", "missing", "blocked"]),
  generatedAt: z.string(),
  datasets: z.array(
    z.object({
      key: z.enum(["dailyMetrics", "sleep", "activity"]),
      label: z.string(),
      rawRows: z.number().int().nonnegative(),
      latestRawAt: z.string().nullable(),
      latestReadModelAt: z.string().nullable(),
      cdcLagSeconds: z.number().nullable(),
      readModelLagSeconds: z.number().nullable(),
      status: z.enum(["healthy", "syncing", "stale", "missing", "blocked"]),
      message: z.string(),
    }),
  ),
});
```

Return one dataset per current health check. For this first pass, derive `missing` from `rawRows === 0`, `healthy` from `rawRows > 0`, and set lag fields to `null`. Keep all computation server-side.

- [ ] **Step 4: Run the server test**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "data health"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
rtk git commit -m "feat: return structured data health"
```

### Task 2: CDC And Read-Model Lag States

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`

- [ ] **Step 1: Add failing stale-state tests**

Add tests named:

```typescript
it("marks data blocked when ClickHouse CDC mirrors are stale", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ count: 10, latest_raw_at: "2026-06-29T12:00:00.000Z" }])
    .mockResolvedValueOnce([{ count: 8, latest_raw_at: "2026-06-29T12:00:00.000Z" }])
    .mockResolvedValueOnce([{ count: 4, latest_raw_at: "2026-06-29T12:00:00.000Z" }]);
  const sensorStore = {
    query: vi.fn(async (_schema: unknown, queryText: string) => {
      if (queryText.includes("peerdb_synced_at")) {
        return [{ table_name: "sleep_session", latest_peerdb_synced_at: "2026-06-28T12:00:00.000Z" }];
      }
      return [{ latest_read_model_at: "2026-06-29T11:55:00.000Z" }];
    }),
  };
  const caller = createCaller({
    db: { execute },
    sensorStore,
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.dataHealth();

  expect(result.overallStatus).toBe("blocked");
  expect(result.datasets.find((dataset) => dataset.key === "sleep")).toEqual(
    expect.objectContaining({
      status: "blocked",
      message: expect.stringContaining("ClickHouse mirror"),
    }),
  );
});

it("marks data stale when dbt read models lag behind raw data", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ count: 10, latest_raw_at: "2026-06-29T12:00:00.000Z" }])
    .mockResolvedValueOnce([{ count: 8, latest_raw_at: "2026-06-29T12:00:00.000Z" }])
    .mockResolvedValueOnce([{ count: 4, latest_raw_at: "2026-06-29T12:00:00.000Z" }]);
  const sensorStore = {
    query: vi.fn().mockResolvedValue([{ latest_read_model_at: "2026-06-29T10:00:00.000Z" }]),
  };
  const caller = createCaller({
    db: { execute },
    sensorStore,
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.dataHealth();

  expect(result.overallStatus).toBe("stale");
  expect(result.datasets[0]?.readModelLagSeconds).toBeGreaterThan(0);
});

it("marks data syncing when an active sync job exists", async () => {
  mockGetJobs.mockResolvedValue([
    {
      id: "job-1",
      data: { userId: "user-1", providerId: "garmin" },
      progress: {},
      getState: vi.fn().mockResolvedValue("waiting"),
    },
  ]);
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ count: 0, latest_raw_at: null }])
    .mockResolvedValueOnce([{ count: 0, latest_raw_at: null }])
    .mockResolvedValueOnce([{ count: 0, latest_raw_at: null }]);
  const caller = createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.dataHealth();

  expect(result.overallStatus).toBe("syncing");
  expect(result.datasets[0]?.status).toBe("missing");
});
```

Use concrete fixtures in each test: `latest_raw_at: "2026-06-29T12:00:00.000Z"`, `latest_read_model_at: "2026-06-29T10:00:00.000Z"`, and stale CDC timestamp `"2026-06-28T12:00:00.000Z"`.

- [ ] **Step 2: Run the stale-state tests and verify RED**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "ClickHouse CDC mirrors|dbt read models|active sync job"
```

Expected: FAIL because lag fields and active-sync state are not computed.

- [ ] **Step 3: Add bounded freshness queries**

Extend `dataHealth` with server-side queries for raw latest timestamps and read-model latest timestamps. Use existing read-model tables only: `analytics.daily_recovery`, `analytics.daily_sleep`, and `analytics.daily_strain`. Do not compute dashboard values in this endpoint; only return freshness metadata.

- [ ] **Step 4: Run server tests**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
rtk git commit -m "feat: expose data freshness lag states"
```

### Task 3: Web Readiness Banner

**Files:**
- Create: `packages/web/src/components/DataReadinessBanner.tsx`
- Create: `packages/web/src/components/DataReadinessBanner.test.tsx`
- Create: `packages/web/src/components/DataReadinessBanner.stories.tsx`
- Modify: `packages/web/src/pages/Dashboard.tsx`
- Modify: `packages/web/src/pages/ActivitiesPage.tsx`
- Modify: `packages/web/src/pages/ProviderDetailPage.tsx`

- [ ] **Step 1: Add the failing component test**

Create `packages/web/src/components/DataReadinessBanner.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataReadinessBanner } from "./DataReadinessBanner.tsx";

describe("DataReadinessBanner", () => {
  it("shows the server-provided readiness message", () => {
    render(
      <DataReadinessBanner
        health={{
          overallStatus: "stale",
          generatedAt: "2026-06-29T12:00:00.000Z",
          datasets: [
            {
              key: "sleep",
              label: "Sleep",
              rawRows: 12,
              latestRawAt: "2026-06-29T08:00:00.000Z",
              latestReadModelAt: "2026-06-28T08:00:00.000Z",
              cdcLagSeconds: null,
              readModelLagSeconds: 86400,
              status: "stale",
              message: "Sleep data is synced, but dashboard summaries are still catching up.",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Sleep data is synced, but dashboard summaries are still catching up.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the component test and verify RED**

```bash
rtk pnpm vitest run --project unit packages/web/src/components/DataReadinessBanner.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the banner and stories**

Implement `DataReadinessBanner` as a compact unframed status band. It must render `health.datasets` messages from the server and must not recompute status from raw timestamps on the client. Add stories for healthy, syncing, stale, missing, and blocked states.

- [ ] **Step 4: Wire web pages**

On dashboard, activities, and provider detail pages, call `trpc.sync.dataHealth.useQuery()` and render the banner above the main content when `overallStatus !== "healthy"`.

- [ ] **Step 5: Run web verification**

```bash
rtk pnpm vitest run --project unit packages/web/src/components/DataReadinessBanner.test.tsx packages/web/src/pages/Dashboard.test.tsx packages/web/src/pages/ActivitiesPage.test.tsx packages/web/src/pages/ProviderDetailPage.test.tsx
rtk pnpm storybook:web:build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/web/src/components/DataReadinessBanner.tsx packages/web/src/components/DataReadinessBanner.test.tsx packages/web/src/components/DataReadinessBanner.stories.tsx packages/web/src/pages/Dashboard.tsx packages/web/src/pages/ActivitiesPage.tsx packages/web/src/pages/ProviderDetailPage.tsx
rtk git commit -m "feat: show web data readiness states"
```

### Task 4: Mobile Readiness Banner

**Files:**
- Create: `packages/mobile/components/DataReadinessBanner.tsx`
- Create: `packages/mobile/components/DataReadinessBanner.test.tsx`
- Create: `packages/mobile/components/DataReadinessBanner.stories.tsx`
- Modify: `packages/mobile/app/(tabs)/index.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.tsx`
- Modify: `packages/mobile/app/providers/[id].tsx`

- [ ] **Step 1: Add the failing mobile component test**

Create `packages/mobile/components/DataReadinessBanner.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react-native";
import { describe, expect, it } from "vitest";
import { DataReadinessBanner } from "./DataReadinessBanner.tsx";

describe("DataReadinessBanner", () => {
  it("renders blocked freshness messages from the server", () => {
    render(
      <DataReadinessBanner
        health={{
          overallStatus: "blocked",
          generatedAt: "2026-06-29T12:00:00.000Z",
          datasets: [
            {
              key: "activity",
              label: "Activities",
              rawRows: 42,
              latestRawAt: "2026-06-29T10:00:00.000Z",
              latestReadModelAt: null,
              cdcLagSeconds: 90000,
              readModelLagSeconds: null,
              status: "blocked",
              message: "Activity data is available, but ClickHouse mirrors are not current.",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Activity data is available, but ClickHouse mirrors are not current.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the mobile component test and verify RED**

```bash
rtk pnpm vitest run --project mobile packages/mobile/components/DataReadinessBanner.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component, stories, and screens**

Implement the mobile banner with the same prop shape as web. Add stories for healthy, syncing, stale, missing, and blocked. Render the banner on the mobile dashboard, activities tab, and provider detail screen from `trpc.sync.dataHealth.useQuery()`.

- [ ] **Step 4: Run mobile verification**

```bash
rtk pnpm vitest run --project mobile packages/mobile/components/DataReadinessBanner.test.tsx packages/mobile/app/(tabs)/index.test.tsx packages/mobile/app/(tabs)/activities.test.tsx packages/mobile/app/providers/[id].test.tsx
rtk pnpm storybook:mobile:build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/mobile/components/DataReadinessBanner.tsx packages/mobile/components/DataReadinessBanner.test.tsx packages/mobile/components/DataReadinessBanner.stories.tsx packages/mobile/app/(tabs)/index.tsx packages/mobile/app/(tabs)/activities.tsx packages/mobile/app/providers/[id].tsx
rtk git commit -m "feat: show mobile data readiness states"
```
