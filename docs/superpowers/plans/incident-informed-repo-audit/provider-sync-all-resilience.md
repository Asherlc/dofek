# Provider Sync All Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make “sync all” return per-provider outcomes so one cooldown, duplicate queue job, or provider failure does not hide the status of every other provider.

**Architecture:** Keep the existing per-provider BullMQ queues and Garmin cooldown behavior. Change only the `sync.triggerSync` response contract so all-provider sync returns `started`, `skippedCooldown`, `alreadyQueued`, or `failed` per provider, and expose global queue backpressure without silently converting failures to success.

**Tech Stack:** TypeScript, tRPC, Zod, BullMQ, Vitest, React, React Native/Expo.

---

## File Structure

- Modify `packages/server/src/routers/sync.ts`: return per-provider outcomes from `triggerSync` and add queue backpressure visibility to `activeSyncs`.
- Modify `packages/server/src/routers/sync.test.ts`: cover cooldown skip, already queued, failed provider, and global queue depth.
- Modify `packages/web/src/components/DataSourcesPanel.tsx` and `packages/web/src/components/SyncProviderCard.tsx`: render per-provider sync outcomes.
- Modify `packages/web/src/components/SyncProviderCard.test.tsx` and stories.
- Modify `packages/mobile/app/providers/index.tsx`, `packages/mobile/app/providers/provider-card.tsx`, and `packages/mobile/app/providers/index.test.tsx`: render the same outcomes on mobile.

### Task 1: Per-Provider Trigger Outcomes

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`

- [ ] **Step 1: Add the failing cooldown test**

Add this test to `packages/server/src/routers/sync.test.ts`:

```typescript
it("returns per-provider outcomes when one sync-all provider is rate limited", async () => {
  mockGetAllProviders.mockReturnValue([
    {
      id: "garmin",
      name: "Garmin",
      validate: () => null,
      authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
    },
    {
      id: "wahoo",
      name: "Wahoo",
      validate: () => null,
      authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
    },
  ]);
  vi.mocked(enqueueSyncJobModule.enqueueSyncJob)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: "job-wahoo" } as never);
  const caller = createCaller({
    db: {
      execute: vi.fn().mockResolvedValueOnce([
        { provider_id: "garmin" },
        { provider_id: "wahoo" },
      ]),
    },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.triggerSync({ sinceDays: 1 });

  expect(result.providerResults).toEqual([
    { providerId: "garmin", status: "skippedCooldown", message: "Provider sync skipped: rate-limit cooldown active" },
    {
      providerId: "wahoo",
      status: "started",
      jobId: "wahoo:job-wahoo",
      queueName: "sync-wahoo",
    },
  ]);
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "per-provider outcomes"
```

Expected: FAIL because `triggerSync` throws `TOO_MANY_REQUESTS` on the first cooldown.

- [ ] **Step 3: Implement outcome schema and sync-all behavior**

Add a `triggerSyncOutputSchema` with:

```typescript
const providerSyncResultSchema = z.discriminatedUnion("status", [
  z.object({ providerId: z.string(), status: z.literal("started"), jobId: z.string(), queueName: z.string() }),
  z.object({ providerId: z.string(), status: z.literal("skippedCooldown"), message: z.string() }),
  z.object({ providerId: z.string(), status: z.literal("alreadyQueued"), jobId: z.string(), queueName: z.string() }),
  z.object({ providerId: z.string(), status: z.literal("failed"), message: z.string() }),
]);
```

For sync-all only, catch each provider enqueue result independently. Preserve single-provider behavior by still throwing for cooldown or failure when `input.providerId` is set.

- [ ] **Step 4: Run server tests**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
rtk git commit -m "feat: return per-provider sync outcomes"
```

### Task 2: Already Queued And Failed Outcomes

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`

- [ ] **Step 1: Add failing outcome tests**

Add two tests:

```typescript
it("reports an already queued provider without failing sync all", async () => {
  mockGetAllProviders.mockReturnValue([
    {
      id: "whoop",
      name: "WHOOP",
      validate: () => null,
      authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
    },
  ]);
  vi.mocked(enqueueSyncJobModule.enqueueSyncJob).mockResolvedValueOnce({
    id: "job-whoop",
    data: { providerId: "whoop", userId: "user-1" },
    alreadyQueued: true,
  } as never);
  const caller = createCaller({
    db: {
      execute: vi.fn().mockResolvedValueOnce([{ provider_id: "whoop" }]),
    },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.triggerSync({ sinceDays: 1 });

  expect(result.providerResults).toEqual([
    {
      providerId: "whoop",
      status: "alreadyQueued",
      jobId: "whoop:job-whoop",
      queueName: "sync-whoop",
    },
  ]);
});

it("reports a failed provider without hiding successful providers", async () => {
  mockGetAllProviders.mockReturnValue([
    {
      id: "polar",
      name: "Polar",
      validate: () => null,
      authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
    },
    {
      id: "wahoo",
      name: "Wahoo",
      validate: () => null,
      authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
    },
  ]);
  vi.mocked(enqueueSyncJobModule.enqueueSyncJob)
    .mockRejectedValueOnce(new Error("provider queue unavailable"))
    .mockResolvedValueOnce({ id: "job-wahoo" } as never);
  const caller = createCaller({
    db: {
      execute: vi.fn().mockResolvedValueOnce([
        { provider_id: "polar" },
        { provider_id: "wahoo" },
      ]),
    },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.triggerSync({ sinceDays: 1 });

  expect(result.providerResults).toEqual([
    {
      providerId: "polar",
      status: "failed",
      message: "provider queue unavailable",
    },
    {
      providerId: "wahoo",
      status: "started",
      jobId: "wahoo:job-wahoo",
      queueName: "sync-wahoo",
    },
  ]);
});
```

Use the same provider/token fixture style as Task 1, with concrete providers `whoop` and `polar`.

- [ ] **Step 2: Run the outcome tests and verify RED**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "already queued|failed provider"
```

Expected: FAIL because `alreadyQueued` and per-provider failure are not represented.

- [ ] **Step 3: Implement minimal outcome mapping**

If `enqueueSyncJob` exposes enough information to distinguish an existing job, map it to `alreadyQueued`; otherwise add a small typed return value in `src/jobs/enqueue-sync-job.ts` and update only its call sites. For thrown errors in sync-all, call `captureException(error)` and return `{ providerId, status: "failed", message }`.

- [ ] **Step 4: Run verification**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts src/jobs/enqueue-sync-job.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts src/jobs/enqueue-sync-job.ts src/jobs/enqueue-sync-job.test.ts
rtk git commit -m "feat: distinguish queued and failed provider syncs"
```

### Task 3: Global Queue Backpressure Visibility

**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`

- [ ] **Step 1: Add failing queue-depth test**

Add:

```typescript
it("returns queue depth for active sync queues", async () => {
  mockGetJobs.mockResolvedValue([{ id: "job-1", data: { userId: "user-1", providerId: "garmin" }, progress: {}, getState: vi.fn().mockResolvedValue("waiting") }]);
  const caller = createCaller({
    db: { execute: vi.fn() },
    userId: "user-1",
    timezone: "UTC",
  });

  const result = await caller.activeSyncs();

  expect(result[0]).toEqual(expect.objectContaining({
    providerId: "garmin",
    queueDepth: expect.any(Number),
  }));
});
```

- [ ] **Step 2: Run the queue-depth test and verify RED**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "queue depth"
```

Expected: FAIL because `activeSyncs` does not expose queue depth.

- [ ] **Step 3: Add queue metadata**

Extend `activeSyncs` result items with `providerId`, `queueName`, and `queueDepth`. Compute depth from the already fetched waiting, delayed, and active jobs per queue; do not add a second Redis scan if the current data is enough.

- [ ] **Step 4: Run server tests**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
rtk git commit -m "feat: expose sync queue backpressure"
```

### Task 4: Web And Mobile Outcome Rendering

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.tsx`
- Modify: `packages/web/src/components/SyncProviderCard.tsx`
- Modify: `packages/web/src/components/SyncProviderCard.test.tsx`
- Modify: `packages/web/src/components/SyncProviderCard.stories.tsx`
- Modify: `packages/mobile/app/providers/index.tsx`
- Modify: `packages/mobile/app/providers/provider-card.tsx`
- Modify: `packages/mobile/app/providers/index.test.tsx`
- Modify: `packages/mobile/app/providers/index.stories.tsx`

- [ ] **Step 1: Add rendering tests**

Add web and mobile tests asserting a skipped Garmin result renders “Cooldown active”, a failed provider renders the server message, and a started provider still polls its `jobId`.

- [ ] **Step 2: Run UI tests and verify RED**

```bash
rtk pnpm vitest run --project unit packages/web/src/components/SyncProviderCard.test.tsx
rtk pnpm vitest run --project mobile packages/mobile/app/providers/index.test.tsx
```

Expected: FAIL until the components consume `providerResults`.

- [ ] **Step 3: Implement rendering**

Map `providerResults` by `providerId`. Render `skippedCooldown`, `alreadyQueued`, and `failed` as per-provider statuses; continue polling `started` and `alreadyQueued` results with a `jobId`. Do not show disabled providers.

- [ ] **Step 4: Run verification**

```bash
rtk pnpm vitest run --project unit packages/web/src/components/SyncProviderCard.test.tsx
rtk pnpm vitest run --project mobile packages/mobile/app/providers/index.test.tsx
rtk pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/SyncProviderCard.tsx packages/web/src/components/SyncProviderCard.test.tsx packages/web/src/components/SyncProviderCard.stories.tsx packages/mobile/app/providers/index.tsx packages/mobile/app/providers/provider-card.tsx packages/mobile/app/providers/index.test.tsx packages/mobile/app/providers/index.stories.tsx
rtk git commit -m "feat: render provider sync outcomes"
```
