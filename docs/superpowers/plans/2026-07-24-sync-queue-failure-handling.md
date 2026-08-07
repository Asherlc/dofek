# Sync Queue Failure Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Redis/BullMQ lookup failures visible and retryable without allowing an active sync to disappear on web or mobile.

**Architecture:** The two server procedures will convert queue dependency failures into contextual Sentry events plus `BAD_GATEWAY` tRPC errors while preserving successful empty-result semantics. Existing web and mobile polling consumers will treat rejected status lookups as transient, retain their last known state, show the server error message, and retry through the existing polling interval.

**Tech Stack:** TypeScript 6, tRPC 11, BullMQ, Sentry, React 19, React Native/Expo 57, TanStack Query 5, Vitest.

## Global Constraints

- Preserve `null` and `[]` only for successful queue lookups with no matching user-owned job.
- Use tRPC `BAD_GATEWAY` for Redis/BullMQ dependency failures.
- Capture every handled unexpected error in Sentry with procedure/job or client polling context.
- Display the server-provided `error.message`; do not replace it with generic client copy.
- Preserve the last known sync status and percentage while a status lookup retries.
- Implement and test both `packages/web` and `packages/mobile`.
- Do not add global tRPC middleware, change unrelated query defaults, or add a cross-platform polling abstraction.
- Follow red-green TDD for every behavior change.

---

### Task 1: Surface queue dependency failures from the sync router

**Files:**
- Modify: `packages/server/src/routers/sync.test.ts:1338-1360`
- Modify: `packages/server/src/routers/sync.test.ts:1680-1720`
- Modify: `packages/server/src/routers/sync.ts:350-430`

**Interfaces:**
- Consumes: `captureException(error, context)` from `@sentry/node` and `TRPCError` from `@trpc/server`.
- Produces: `syncStatus` and `activeSyncs` failures with tRPC code `BAD_GATEWAY`.

- [ ] **Step 1: Replace the `syncStatus` Redis-empty test with a failing error contract test**

```typescript
it("reports Redis failures instead of returning a missing job", async () => {
  const redisError = new Error("Redis connection refused");
  mockGetJob.mockRejectedValueOnce(redisError);

  const caller = createCaller({
    db: { execute: vi.fn().mockResolvedValue([]) },
    userId: "user-1",
    timezone: "UTC",
  });

  await expect(caller.syncStatus({ jobId: "some-job" })).rejects.toMatchObject({
    code: "BAD_GATEWAY",
    message: "Sync status is temporarily unavailable. Please try again.",
  });
  expect(mockCaptureException).toHaveBeenCalledWith(redisError, {
    tags: { procedure: "sync.syncStatus" },
    extra: { jobId: "some-job" },
  });
});
```

- [ ] **Step 2: Replace the `activeSyncs` Redis-empty test with a failing error contract test**

```typescript
it("reports Redis failures instead of returning no active syncs", async () => {
  const redisError = new Error("Redis connection refused");
  mockGetJobs.mockRejectedValueOnce(redisError);

  const caller = createCaller({
    db: { execute: vi.fn().mockResolvedValue([]) },
    userId: "user-1",
    timezone: "UTC",
  });

  await expect(caller.activeSyncs()).rejects.toMatchObject({
    code: "BAD_GATEWAY",
    message: "Active syncs are temporarily unavailable. Please try again.",
  });
  expect(mockCaptureException).toHaveBeenCalledWith(redisError, {
    tags: { procedure: "sync.activeSyncs" },
  });
});
```

- [ ] **Step 3: Run the two tests and verify RED**

Run:

```bash
rtk pnpm vitest run packages/server/src/routers/sync.test.ts --project unit -t "reports Redis failures"
```

Expected: both tests fail because the procedures resolve to `null`/`[]` and do not capture the errors.

- [ ] **Step 4: Implement the minimal server error handling**

Change the `syncStatus` queue catch to:

```typescript
} catch (error: unknown) {
  captureException(error, {
    tags: { procedure: "sync.syncStatus" },
    extra: { jobId: input.jobId },
  });
  throw new TRPCError({
    code: "BAD_GATEWAY",
    message: "Sync status is temporarily unavailable. Please try again.",
    cause: error,
  });
}
```

Change the `activeSyncs` queue catch to:

```typescript
} catch (error: unknown) {
  captureException(error, {
    tags: { procedure: "sync.activeSyncs" },
  });
  throw new TRPCError({
    code: "BAD_GATEWAY",
    message: "Active syncs are temporarily unavailable. Please try again.",
    cause: error,
  });
}
```

- [ ] **Step 5: Run the focused server tests and verify GREEN**

Run:

```bash
rtk pnpm vitest run packages/server/src/routers/sync.test.ts --project unit -t "syncStatus|activeSyncs"
```

Expected: all `syncStatus` and `activeSyncs` tests pass, including existing missing-job, cross-user, malformed-job, and no-active-job cases.

- [ ] **Step 6: Commit the server behavior**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
rtk git commit -m "fix(server): surface sync queue failures"
```

---

### Task 2: Preserve web polling state across transient status errors

**Files:**
- Modify: `packages/web/src/lib/poll-sync-job.test.ts:20-50`
- Modify: `packages/web/src/lib/poll-sync-job.ts:20-55`

**Interfaces:**
- Consumes: `PollSyncJobOptions.fetchStatus(jobId): Promise<SyncJobStatus | null>`.
- Produces: transient rejected lookups as `{status: "syncing", message: error.message}` updates followed by another poll; successful `null` remains terminal.

- [ ] **Step 1: Replace the fetch-throws terminal test with a failure-then-recovery test**

```typescript
it("preserves syncing state, shows the server error, and retries", async () => {
  const updateState = vi.fn();
  const fetchStatus = vi
    .fn()
    .mockRejectedValueOnce(new Error("Sync status is temporarily unavailable. Please try again."))
    .mockResolvedValueOnce({
      status: "completed",
      providers: { wahoo: { status: "done", message: "5 synced" } },
    });
  const onComplete = vi.fn();

  await pollSyncJob({
    jobId: "sync-123",
    providerIds: ["wahoo"],
    fetchStatus,
    updateState,
    onComplete,
    pollIntervalMs: 0,
  });

  expect(updateState).toHaveBeenNthCalledWith(1, "wahoo", {
    status: "syncing",
    message: "Sync status is temporarily unavailable. Please try again.",
  });
  expect(updateState).toHaveBeenNthCalledWith(2, "wahoo", {
    status: "done",
    message: "5 synced",
  });
  expect(fetchStatus).toHaveBeenCalledTimes(2);
  expect(onComplete).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk pnpm vitest run packages/web/src/lib/poll-sync-job.test.ts --project unit -t "preserves syncing state"
```

Expected: FAIL because the first rejection changes the provider to terminal `error` and stops polling.

- [ ] **Step 3: Implement retry without clearing the last known state**

Replace the rejected-fetch catch in `pollSyncJob` with:

```typescript
} catch (error: unknown) {
  const message =
    error instanceof Error ? error.message : "Sync status is temporarily unavailable.";
  for (const providerId of providerIds) {
    updateState(providerId, { status: "syncing", message });
  }
  if (pollIntervalMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return poll();
}
```

Keep the successful `null` branch and its `"Lost sync status"` terminal state unchanged.

- [ ] **Step 4: Run the complete helper test file and verify GREEN**

Run:

```bash
rtk pnpm vitest run packages/web/src/lib/poll-sync-job.test.ts --project unit
```

Expected: all tests pass.

- [ ] **Step 5: Commit the web polling behavior**

```bash
rtk git add packages/web/src/lib/poll-sync-job.ts packages/web/src/lib/poll-sync-job.test.ts
rtk git commit -m "fix(web): retry unavailable sync status"
```

---

### Task 3: Display web active-sync errors and prevent false auto-sync

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx:1-180`
- Modify: `packages/web/src/components/DataSourcesPanel.tsx:30-45`
- Modify: `packages/web/src/components/DataSourcesPanel.tsx:265-290`
- Modify: `packages/web/src/hooks/useAutoSync.test.ts:10-35`
- Modify: `packages/web/src/hooks/useAutoSync.test.ts:145-190`
- Modify: `packages/web/src/hooks/useAutoSync.ts:110-130`

**Interfaces:**
- Consumes: TanStack query result fields `data`, `isLoading`, and `error`.
- Produces: visible `activeSyncs.error.message` and an auto-sync guard while that error exists.

- [ ] **Step 1: Make the Data Sources active-sync query mock mutable**

Add:

```typescript
const mockActiveSyncsQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<Array<Record<string, unknown>>>>(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
);
```

Use it in the tRPC mock:

```typescript
activeSyncs: { useQuery: mockActiveSyncsQuery },
```

Reset it in `beforeEach` to `{ data: [], isLoading: false, error: null }`.

- [ ] **Step 2: Add a failing Data Sources rendering test**

```typescript
it("shows the active sync server error message", () => {
  mockActiveSyncsQuery.mockReturnValue({
    data: [],
    isLoading: false,
    error: new Error("Active syncs are temporarily unavailable. Please try again."),
  });

  render(<DataSourcesPanel />);

  expect(
    screen.getByText("Active syncs are temporarily unavailable. Please try again."),
  ).toBeTruthy();
});
```

- [ ] **Step 3: Add `error` to the web auto-sync mock and a failing duplicate-prevention test**

Change the mock type and default:

```typescript
type ActiveSyncsQuery = {
  data: ActiveSync[];
  isLoading: boolean;
  error: Error | null;
};

const mockActiveSyncs: ActiveSyncsQuery = {
  data: [],
  isLoading: false,
  error: null,
};
```

Add:

```typescript
it("does not trigger when active sync lookup fails", async () => {
  mockActiveSyncs.error = new Error(
    "Active syncs are temporarily unavailable. Please try again.",
  );
  const { useAutoSync } = await import("./useAutoSync");

  renderHook(() => useAutoSync("2026-03-21"));

  expect(mockMutate).not.toHaveBeenCalled();
});
```

Reset `mockActiveSyncs.error = null` in `beforeEach`.

- [ ] **Step 4: Run the two focused tests and verify RED**

Run:

```bash
rtk pnpm vitest run packages/web/src/components/DataSourcesPanel.test.tsx packages/web/src/hooks/useAutoSync.test.ts --project unit -t "active sync"
```

Expected: the panel cannot find the server message, and auto-sync calls `mutate`.

- [ ] **Step 5: Render the active-sync error without hiding provider data**

Add near the Data Sources heading in `DataSourcesPanel`:

```tsx
{activeSyncs.error ? (
  <p role="alert" className="text-sm text-red-400">
    {activeSyncs.error.message}
  </p>
) : null}
```

Do not return early; cached provider and active-job state must continue rendering.

- [ ] **Step 6: Guard web auto-sync against lookup errors**

Add before the active-job length check:

```typescript
if (activeSyncs.error) return;
```

Add `activeSyncs.error` to the effect dependency list.

- [ ] **Step 7: Run the two affected web test files and verify GREEN**

Run:

```bash
rtk pnpm vitest run packages/web/src/components/DataSourcesPanel.test.tsx packages/web/src/hooks/useAutoSync.test.ts --project unit
```

Expected: both files pass.

- [ ] **Step 8: Commit the web query-state changes**

```bash
rtk git add packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/DataSourcesPanel.test.tsx packages/web/src/hooks/useAutoSync.ts packages/web/src/hooks/useAutoSync.test.ts
rtk git commit -m "fix(web): retain sync state on queue outage"
```

---

### Task 4: Preserve mobile provider-list polling and show active-sync errors

**Files:**
- Modify: `packages/mobile/app/providers/index.test.tsx:270-420`
- Modify: `packages/mobile/app/providers/index.test.tsx:910-1220`
- Modify: `packages/mobile/app/providers/index.tsx:80-110`
- Modify: `packages/mobile/app/providers/index.tsx:188-275`
- Modify: `packages/mobile/app/providers/index.tsx:680-725`

**Interfaces:**
- Consumes: `trpc.sync.activeSyncs.useQuery()` and imperative `syncStatus.fetch`.
- Produces: retained `syncingProviders`, retained percentages, visible server messages, and continued polling after rejected status requests.

- [ ] **Step 1: Give the active-sync test mock its full query shape**

Change default setup to:

```typescript
mockActiveSyncsQuery.mockReturnValue({
  data: [],
  isLoading: false,
  error: null,
});
```

- [ ] **Step 2: Add a failing active-sync error rendering test**

```typescript
it("shows the active sync server error message", async () => {
  mockActiveSyncsQuery.mockReturnValue({
    data: [],
    isLoading: false,
    error: new Error("Active syncs are temporarily unavailable. Please try again."),
  });

  await renderProvidersScreen();

  expect(
    screen.getByText("Active syncs are temporarily unavailable. Please try again."),
  ).toBeTruthy();
});
```

- [ ] **Step 3: Add a failure-then-recovery polling test**

```typescript
it("keeps provider progress visible while sync status retries", async () => {
  vi.useFakeTimers();
  try {
    mockActiveSyncsQuery.mockReturnValue({
      data: [
        {
          jobId: "wahoo:active-job",
          status: "running",
          percentage: 40,
          providers: {
            wahoo: { status: "running", message: "Downloading activities..." },
          },
        },
      ],
      isLoading: false,
      error: null,
    });
    mockSyncStatusFetch
      .mockRejectedValueOnce(
        new Error("Sync status is temporarily unavailable. Please try again."),
      )
      .mockResolvedValueOnce({
        status: "running",
        percentage: 60,
        providers: {
          wahoo: { status: "running", message: "Fetching activities..." },
        },
      })
      .mockImplementationOnce(() => new Promise(() => undefined));

    const rendered = await renderProvidersScreen();
    await act(async () => Promise.resolve());

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    expect(
      wahooCard.getByText("Sync status is temporarily unavailable. Please try again."),
    ).toBeTruthy();
    expect(wahooCard.getByText("40%")).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(wahooCard.getByText("Fetching activities...")).toBeTruthy();
    expect(wahooCard.getByText("60%")).toBeTruthy();
    rendered.unmount();
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 4: Run the focused mobile provider tests and verify RED**

Run:

```bash
rtk pnpm vitest run packages/mobile/app/providers/index.test.tsx --project mobile -t "active sync server error|failure-then-recovery"
```

Expected: the error panel is absent and the rejected poll cleans up Wahoo's syncing/progress state.

- [ ] **Step 5: Retry provider-list polls while retaining state**

Replace the rejected status branch with:

```typescript
} catch (error: unknown) {
  captureException(error, { context: "sync-status-poll" });
  if (!isMounted.current) return;
  const message =
    error instanceof Error ? error.message : "Sync status is temporarily unavailable.";
  setSyncProgress((previous) => {
    const next = { ...previous };
    for (const providerId of providerIds) {
      next[providerId] = { ...next[providerId], message };
    }
    return next;
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return poll();
}
```

Do not call `cleanup()` in this branch.

- [ ] **Step 6: Render mobile `activeSyncs.error.message`**

Before the provider cards, add:

```tsx
{activeSyncs.error ? (
  <QueryStatePanel
    variant="error"
    title="Could not load sync progress"
    message={getQueryErrorMessage(
      activeSyncs.error,
      "Unable to load sync progress.",
    )}
    minHeight={96}
  />
) : null}
```

- [ ] **Step 7: Run the mobile provider test file and verify GREEN**

Run:

```bash
rtk pnpm vitest run packages/mobile/app/providers/index.test.tsx --project mobile
```

Expected: all provider-list tests pass.

- [ ] **Step 8: Commit the mobile provider-list behavior**

```bash
rtk git add packages/mobile/app/providers/index.tsx packages/mobile/app/providers/index.test.tsx
rtk git commit -m "fix(mobile): retain provider sync progress"
```

---

### Task 5: Preserve mobile provider-detail and automatic sync polling

**Files:**
- Modify: `packages/mobile/app/providers/[id].test.tsx:560-690`
- Modify: `packages/mobile/app/providers/use-provider-detail-actions.ts:112-155`
- Modify: `packages/mobile/lib/useAutoSync.test.ts:15-35`
- Modify: `packages/mobile/lib/useAutoSync.test.ts:150-255`
- Modify: `packages/mobile/lib/useAutoSync.ts:46-85`

**Interfaces:**
- Consumes: imperative `syncStatus.fetch` errors and `activeSyncs.error`.
- Produces: provider-detail retry with the visible server message; auto-sync guard on active lookup errors; auto-sync status polling recovery after transient rejection.

- [ ] **Step 1: Add a failing provider-detail failure-then-recovery test**

```typescript
it("keeps sync active and retries when status is temporarily unavailable", async () => {
  vi.useFakeTimers();
  try {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
    mockSyncStatusFetch
      .mockRejectedValueOnce(
        new Error("Sync status is temporarily unavailable. Please try again."),
      )
      .mockResolvedValueOnce({
        status: "completed",
        percentage: 100,
        providers: { wahoo: { status: "done", message: "Done" } },
      });

    const { default: ProviderDetailScreen } = await import("./[id]");
    render(<ProviderDetailScreen />);
    fireEvent.click(screen.getByText("Sync"));
    await act(async () => Promise.resolve());

    expect(
      screen.getByText("Sync status is temporarily unavailable. Please try again."),
    ).toBeTruthy();
    expect(screen.getByText("Syncing...")).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(screen.getByText("Sync complete")).toBeTruthy();
    expect(mockSyncStatusFetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
```

Add `act` to the existing `@testing-library/react` import.

- [ ] **Step 2: Add `error` to the mobile auto-sync query mock**

Change:

```typescript
let mockActiveSyncs: {
  data: unknown[] | undefined;
  isLoading: boolean;
  error: Error | null;
};
```

Reset with:

```typescript
mockActiveSyncs = { data: [], isLoading: false, error: null };
```

- [ ] **Step 3: Add failing mobile auto-sync guard and retry tests**

Guard test:

```typescript
it("does not trigger when active sync lookup fails", async () => {
  mockActiveSyncs.error = new Error(
    "Active syncs are temporarily unavailable. Please try again.",
  );

  renderHook(() => useAutoSync("2026-03-21"));
  await act(() => vi.runAllTimersAsync());

  expect(mockMutateAsync).not.toHaveBeenCalled();
});
```

Polling recovery test:

```typescript
it("retries sync status after a transient server error", async () => {
  const statusError = new Error(
    "Sync status is temporarily unavailable. Please try again.",
  );
  mockSyncStatusFetch
    .mockRejectedValueOnce(statusError)
    .mockResolvedValueOnce({ status: "completed" });

  renderHook(() => useAutoSync("2026-03-21"));
  await act(() => vi.runAllTimersAsync());

  expect(mockSyncStatusFetch).toHaveBeenCalledTimes(2);
  expect(mockCaptureException).toHaveBeenCalledWith(statusError, {
    source: "auto-sync-status",
  });
  expect(mockDashboardInvalidate).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
rtk pnpm vitest run packages/mobile/app/providers/'[id].test.tsx' packages/mobile/lib/useAutoSync.test.ts --project mobile -t "transient server error|active sync lookup fails|failure-then-recovery"
```

Expected: provider detail stops with generic `"Sync failed"` and mobile auto-sync either starts a duplicate or terminates polling after the first rejection.

- [ ] **Step 5: Retry provider-detail polling with the server message**

Change the catch in `use-provider-detail-actions.ts` to:

```typescript
} catch (error: unknown) {
  captureException(error, { context: "provider-sync-poll" });
  setSyncMessage(
    error instanceof Error ? error.message : "Sync status is temporarily unavailable.",
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return poll();
}
```

Do not clear `pollingRef` or `isSyncing` in the transient error branch.

- [ ] **Step 6: Guard and retry mobile automatic sync**

Before checking active-sync data:

```typescript
if (activeSyncs.error) return;
```

Add `activeSyncs.error` to the effect dependency list.

Inside `pollUntilDone`, wrap only `syncStatus.fetch`:

```typescript
let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
try {
  status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
} catch (error: unknown) {
  captureException(error, { source: "auto-sync-status" });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return pollUntilDone();
}
```

Keep successful `null`, completed, and failed results terminal.

- [ ] **Step 7: Run both affected mobile test files and verify GREEN**

Run:

```bash
rtk pnpm vitest run packages/mobile/app/providers/'[id].test.tsx' packages/mobile/lib/useAutoSync.test.ts --project mobile
```

Expected: both files pass.

- [ ] **Step 8: Commit the remaining mobile behavior**

```bash
rtk git add packages/mobile/app/providers/use-provider-detail-actions.ts packages/mobile/app/providers/'[id].test.tsx' packages/mobile/lib/useAutoSync.ts packages/mobile/lib/useAutoSync.test.ts
rtk git commit -m "fix(mobile): retry sync status outages"
```

---

### Task 6: Run cross-platform regression validation

**Files:**
- Verify all files changed in Tasks 1-5.

**Interfaces:**
- Consumes: completed server, web, and mobile changes.
- Produces: evidence that the issue is fixed without regressions.

- [ ] **Step 1: Run all directly affected tests**

```bash
rtk pnpm vitest run \
  packages/server/src/routers/sync.test.ts \
  packages/web/src/lib/poll-sync-job.test.ts \
  packages/web/src/components/DataSourcesPanel.test.tsx \
  packages/web/src/hooks/useAutoSync.test.ts \
  packages/mobile/app/providers/index.test.tsx \
  packages/mobile/app/providers/'[id].test.tsx' \
  packages/mobile/lib/useAutoSync.test.ts \
  --project unit --project mobile
```

Expected: all selected tests pass.

- [ ] **Step 2: Run changed unit/mobile tests**

```bash
rtk pnpm test:changed
```

Expected: PASS with no failed unit or mobile tests.

- [ ] **Step 3: Run static validation**

```bash
rtk pnpm lint
rtk pnpm typecheck
rtk pnpm --dir packages/web typecheck
rtk pnpm --dir packages/mobile typecheck
rtk git diff --check origin/main...
```

Expected: every command exits 0 with no errors.

- [ ] **Step 4: Review the final diff against the issue**

```bash
rtk git diff --stat origin/main...
rtk git diff origin/main... -- \
  packages/server/src/routers/sync.ts \
  packages/web/src/lib/poll-sync-job.ts \
  packages/web/src/components/DataSourcesPanel.tsx \
  packages/web/src/hooks/useAutoSync.ts \
  packages/mobile/app/providers/index.tsx \
  packages/mobile/app/providers/use-provider-detail-actions.ts \
  packages/mobile/lib/useAutoSync.ts
```

Expected: no unrelated refactors, config changes, dependency changes, or empty-state behavior changes.

- [ ] **Step 5: Prepare the PR**

Use the repository `ship-pr` workflow. The PR body must contain:

```markdown
Fixes #1736
```

After opening it, comment on issue #1736 with the PR URL and confirm both links.
