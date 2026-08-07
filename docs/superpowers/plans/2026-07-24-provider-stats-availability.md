# Provider Stats Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ClickHouse provider-stat outages from reporting connected push-only providers as disconnected while preserving and visibly identifying stale provider data on web and mobile.

**Architecture:** `sync.providers` will log and rethrow provider-stat failures so the existing tRPC infrastructure sanitizer returns the retryable `SERVICE_UNAVAILABLE` analytics error. TanStack Query will retain the last successful provider response; web and mobile will render that retained data alongside an error notice instead of replacing it with fabricated disconnected state.

**Tech Stack:** TypeScript, tRPC, TanStack Query, React, React Native, Vitest, Testing Library

## Global Constraints

- Keep successful zero-data provider-stat responses mapped to `authorized: false`.
- Do not add retries, fallback data, persistence mechanisms, or a nullable authorization state.
- Continue reporting unexpected failures to Sentry and surfacing the server-provided actionable message.
- Keep authorization computation on the server; clients only render server-computed values.
- Implement and verify each behavior test-first.

---

## File Structure

- `packages/server/src/routers/sync.ts`: Stop manufacturing empty provider statistics after a failed ClickHouse query.
- `packages/server/src/routers/sync.test.ts`: Prove failures reject and successful zero-data results remain disconnected.
- `packages/web/src/components/DataSourcesPanel.tsx`: Render the provider query error without hiding retained data.
- `packages/web/src/components/DataSourcesPanel.test.tsx`: Prove cached provider cards and the retryable error render together.
- `packages/mobile/app/providers/index.tsx`: Use retained provider data even when the background query has an error.
- `packages/mobile/app/providers/index.test.tsx`: Prove cached provider cards and the retryable error render together.

### Task 1: Make Provider Inventory Fail on Provider-Stats Outage

**Files:**

- Modify: `packages/server/src/routers/sync.ts:252-262`
- Test: `packages/server/src/routers/sync.test.ts:602-655`

**Interfaces:**

- Consumes: `SyncRepository.getProviderStats(): Promise<ProviderStatRow[]>`
- Produces: `sync.providers` rejects when `getProviderStats()` rejects; the existing tRPC middleware sanitizes recognized ClickHouse infrastructure errors to `SERVICE_UNAVAILABLE`.

- [ ] **Step 1: Replace the continuation test with a failing rejection test**

Change the existing `"logs and continues when provider stats lookup fails"` test to:

```typescript
it("rejects instead of marking push providers disconnected when provider stats lookup fails", async () => {
  mockGetAllProviders.mockReturnValue([]);
  const providerStatsError = Object.assign(
    new Error("connect ECONNREFUSED clickhouse:8123"),
    { code: "ECONNREFUSED" },
  );

  const caller = createCaller({
    db: createProvidersDbMock(),
    sensorStore: {
      query: createSensorStoreQuery({
        providerStats: providerStatsError,
      }),
    },
    userId: "user-1",
    timezone: "UTC",
  });

  await expect(caller.providers()).rejects.toThrow("connect ECONNREFUSED clickhouse:8123");
  expect(mockLoggerWarn).toHaveBeenCalledWith(
    "[sync.providers] provider stats lookup failed: connect ECONNREFUSED clickhouse:8123",
  );
  expect(mockCaptureException).toHaveBeenCalledWith(providerStatsError);
});
```

- [ ] **Step 2: Run the server test and verify RED**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/server/src/routers/sync.test.ts
```

Expected: FAIL because `caller.providers()` currently resolves with push providers whose `authorized` value is `false`.

- [ ] **Step 3: Rethrow provider-stat failures after reporting them**

In `sync.providers`, replace the empty-array fallback with:

```typescript
repo.getProviderStats().catch((error: unknown) => {
  logProvidersQueryFailure("provider stats lookup", error);
  throw error;
})
```

Remove the `ProviderStatRow` type import from `sync.ts` if it is no longer used.

- [ ] **Step 4: Run the server test and verify GREEN**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/server/src/routers/sync.test.ts
```

Expected: PASS, including the new rejection assertion and existing logging/Sentry assertions.

- [ ] **Step 5: Add an explicit successful zero-data regression test**

Add beside the push-provider authorization tests:

```typescript
it("marks push provider unauthorized after a successful zero-data stats query", async () => {
  mockGetAllProviders.mockReturnValue([]);

  const caller = createCaller({
    db: createProvidersDbMock(),
    sensorStore: {
      query: createSensorStoreQuery({ providerStats: [] }),
    },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.providers();

  expect(
    result.find((provider: { id: string }) => provider.id === "whoop_ble")?.authorized,
  ).toBe(false);
});
```

- [ ] **Step 6: Run the server test again**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/server/src/routers/sync.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the server behavior**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
rtk git commit -m "fix(server): fail provider inventory on stats outage"
```

### Task 2: Preserve and Identify Stale Provider Data on Web

**Files:**

- Modify: `packages/web/src/components/DataSourcesPanel.tsx:1-10,344-370`
- Test: `packages/web/src/components/DataSourcesPanel.test.tsx`

**Interfaces:**

- Consumes: TanStack query result fields `providers.data`, `providers.error`, and `providers.isLoading`.
- Produces: The data sources panel renders retained provider cards and a `QueryStatePanel` error simultaneously.

- [ ] **Step 1: Add the failing cached-data-with-error component test**

Add to `describe("DataSourcesPanel")`:

```tsx
it("keeps cached providers visible when a background refresh fails", () => {
  const refreshError = new Error(
    "Analytics data is temporarily unavailable. Please retry in a minute.",
  );
  mockProvidersQuery.mockReturnValue({
    data: [
      {
        id: "garmin",
        name: "Garmin",
        authorized: true,
        authType: "custom:garmin",
        importOnly: false,
        pushOnly: false,
        needsReauth: false,
      },
    ],
    isLoading: false,
    error: refreshError,
  });

  render(<DataSourcesPanel />);

  expect(screen.getByTestId("provider-card-garmin")).toBeTruthy();
  expect(screen.getByText(refreshError.message)).toBeTruthy();
});
```

- [ ] **Step 2: Run the web component test and verify RED**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/web/src/components/DataSourcesPanel.test.tsx
```

Expected: FAIL because the provider card renders but the provider query error is not displayed.

- [ ] **Step 3: Render the provider query error without gating retained data**

Import the shared web query state component:

```typescript
import { QueryStatePanel } from "./QueryStatePanel.tsx";
```

After `ProcessingStatusWidget` and before the provider grid, add:

```tsx
{providers.error ? <QueryStatePanel error={providers.error} height={72} /> : null}
```

Do not change `const allProviders = providers.data ?? []`; retained data must remain the input to the provider cards.

- [ ] **Step 4: Run the web component test and verify GREEN**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/web/src/components/DataSourcesPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the web behavior**

```bash
rtk git add packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/DataSourcesPanel.test.tsx
rtk git commit -m "fix(web): retain providers on refresh failure"
```

### Task 3: Preserve and Identify Stale Provider Data on Mobile

**Files:**

- Modify: `packages/mobile/app/providers/index.tsx:544-554`
- Test: `packages/mobile/app/providers/index.test.tsx`

**Interfaces:**

- Consumes: TanStack query result fields `providers.data`, `providers.error`, and `providers.isLoading`.
- Produces: The mobile provider screen maps retained server data even when its background query has an error; the existing error panel remains visible.

- [ ] **Step 1: Add the failing cached-data-with-error screen test**

Add to `describe("ProvidersScreen")`:

```tsx
it("keeps cached providers visible when a background refresh fails", async () => {
  const refreshError = new Error(
    "Analytics data is temporarily unavailable. Please retry in a minute.",
  );
  mockProvidersQuery.mockReturnValue({
    data: [connectedProvider],
    isLoading: false,
    error: refreshError,
  });

  const { default: ProvidersScreen } = await import("./index.tsx");
  render(<ProvidersScreen />);

  expect(screen.getByTestId("provider-card-wahoo")).toBeTruthy();
  expect(screen.getByText(refreshError.message)).toBeTruthy();
});
```

- [ ] **Step 2: Run the mobile screen test and verify RED**

Run:

```bash
rtk pnpm exec vitest run --project mobile packages/mobile/app/providers/index.test.tsx
```

Expected: FAIL because the existing provider mapping replaces retained data with an empty list whenever `providers.error` is set.

- [ ] **Step 3: Map retained provider data independently of query error state**

Change:

```typescript
const providerList: Provider[] = (providers.error ? [] : (providers.data ?? [])).map((p) => ({
```

to:

```typescript
const providerList: Provider[] = (providers.data ?? []).map((provider) => ({
```

Rename the callback references from `p` to `provider` throughout that mapping to preserve the repository rule requiring descriptive variable names. Keep the existing `providers.error` `QueryStatePanel`; it provides the retryable warning while the retained cards remain visible.

- [ ] **Step 4: Run the mobile screen test and verify GREEN**

Run:

```bash
rtk pnpm exec vitest run --project mobile packages/mobile/app/providers/index.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the mobile behavior**

```bash
rtk git add packages/mobile/app/providers/index.tsx packages/mobile/app/providers/index.test.tsx
rtk git commit -m "fix(mobile): retain providers on refresh failure"
```

### Task 4: Cross-Platform Verification

**Files:**

- Verify: `packages/server/src/routers/sync.ts`
- Verify: `packages/server/src/routers/sync.test.ts`
- Verify: `packages/web/src/components/DataSourcesPanel.tsx`
- Verify: `packages/web/src/components/DataSourcesPanel.test.tsx`
- Verify: `packages/mobile/app/providers/index.tsx`
- Verify: `packages/mobile/app/providers/index.test.tsx`

**Interfaces:**

- Consumes: The completed server, web, and mobile tasks.
- Produces: A linted, type-safe, test-verified branch ready for review.

- [ ] **Step 1: Run all changed unit and mobile tests**

Run:

```bash
rtk pnpm test:changed
```

Expected: PASS with no failed unit or mobile tests.

- [ ] **Step 2: Run package type checks**

Run:

```bash
rtk pnpm --filter dofek-server typecheck
rtk pnpm --filter dofek-web typecheck
rtk pnpm --filter dofek-mobile typecheck
```

Expected: all three commands exit successfully with no TypeScript errors.

- [ ] **Step 3: Run lint and diff validation**

Run:

```bash
rtk pnpm biome check packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/DataSourcesPanel.test.tsx packages/mobile/app/providers/index.tsx packages/mobile/app/providers/index.test.tsx
rtk git diff --check origin/main...
```

Expected: both commands exit successfully with no diagnostics.

- [ ] **Step 4: Review the final branch diff**

Run:

```bash
rtk git diff --stat origin/main...
rtk git diff origin/main... -- packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/DataSourcesPanel.test.tsx packages/mobile/app/providers/index.tsx packages/mobile/app/providers/index.test.tsx
```

Expected: only the approved server fallback removal, cross-platform stale-data presentation, and focused tests are present.

- [ ] **Step 5: Commit any verification-only formatting corrections**

If Biome made no changes, skip this step. If formatting corrections were required:

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/DataSourcesPanel.test.tsx packages/mobile/app/providers/index.tsx packages/mobile/app/providers/index.test.tsx
rtk git commit -m "style: format provider outage fix"
```
