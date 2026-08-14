# Provider Sync All Resilience Implementation Plan

> **Status note (2026-07-02):** The core implementation described here has already landed on
> `origin/main`: `sync.triggerSync` returns per-provider `providerResults`, server tests cover
> `skippedCooldown`, `alreadyQueued`, and `failed` outcomes, and web/mobile provider screens render
> those outcomes without polling fake jobs for non-pollable results. Queue visibility landed as the
> admin `sync.queueBackpressure` route instead of `queueDepth` fields on `activeSyncs`; keep that
> shape unless a failing user-facing test proves active sync rows need queue depth too. Follow-up
> verification and plan reconciliation are tracked in
> [`2026-07-02-provider-sync-all-resilience-verification.md`](../2026-07-02-provider-sync-all-resilience-verification.md)
> and GitHub issue #1458.
>
> **Archive note (2026-07-03):** Treat the checklist below as the original historical TDD script,
> not active outstanding work. Issue #1458 verified the implemented server, web, and mobile behavior
> and recorded the remaining local lint blocker in the verification plan.

**Goal:** Make “sync all” return per-provider outcomes so one cooldown, duplicate queue job, or provider failure does not hide the status of every other provider.
**Architecture:** Keep the existing per-provider BullMQ queues and Garmin cooldown behavior. Change only the `sync.triggerSync` response contract so all-provider sync returns `started`, `skippedCooldown`, `alreadyQueued`, or `failed` per provider, and expose global queue backpressure without silently converting failures to success.
**Tech Stack:** TypeScript, tRPC, Zod, BullMQ, Vitest, React, React Native/Expo.
**Primary Sources:** Existing `triggerSync`, `activeSyncs`, and queue backpressure behavior lives in [`packages/server/src/routers/sync.ts`](../../../../packages/server/src/routers/sync.ts) and is covered by [`packages/server/src/routers/sync.test.ts`](../../../../packages/server/src/routers/sync.test.ts). Web provider sync rendering is in [`packages/web/src/components/DataSourcesPanel.tsx`](../../../../packages/web/src/components/DataSourcesPanel.tsx), [`packages/web/src/components/SyncProviderCard.tsx`](../../../../packages/web/src/components/SyncProviderCard.tsx), and [`packages/web/src/components/SyncProviderCard.test.tsx`](../../../../packages/web/src/components/SyncProviderCard.test.tsx). Mobile provider rendering is in [`packages/mobile/app/providers/index.tsx`](../../../../packages/mobile/app/providers/index.tsx) and [`packages/mobile/app/providers/provider-card.tsx`](../../../../packages/mobile/app/providers/provider-card.tsx).
## File Structure
- Server router: `packages/server/src/routers/sync.ts` returns per-provider outcomes from `triggerSync` and adds queue backpressure visibility to `activeSyncs`.
- Server tests: `packages/server/src/routers/sync.test.ts` covers cooldown skip, already queued, failed provider, and global queue depth.
- Web UI: `packages/web/src/components/DataSourcesPanel.tsx` and `packages/web/src/components/SyncProviderCard.tsx` render per-provider sync outcomes.
- Web coverage: `packages/web/src/components/SyncProviderCard.test.tsx` and stories cover the rendered outcomes.
- Mobile UI and coverage: `packages/mobile/app/providers/index.tsx`, `packages/mobile/app/providers/provider-card.tsx`, and `packages/mobile/app/providers/index.test.tsx` render the same outcomes on mobile.
### Task 1: Per-Provider Trigger Outcomes
**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`
- [ ] **Step 1 (RED): Add the failing cooldown test**
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
- [ ] **Step 2 (RED): Run the test and verify the expected failure**
```bash
pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "per-provider outcomes"
```
Expected: FAIL because `triggerSync` throws `TOO_MANY_REQUESTS` on the first cooldown.
- [ ] **Step 3 (GREEN): Implement outcome schema and sync-all behavior**
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
- [ ] **Step 4 (GREEN): Run server tests**
```bash
pnpm vitest run --project unit packages/server/src/routers/sync.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit the per-provider outcome contract**
```bash
git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
git commit -m "feat: return per-provider sync outcomes"
```
### Task 2: Already Queued And Failed Outcomes
**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`
- [ ] **Step 1 (RED): Add failing outcome tests**
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
- [ ] **Step 2 (RED): Run the outcome tests and verify the expected failures**
```bash
pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "already queued|failed provider"
```
Expected: FAIL because `alreadyQueued` and per-provider failure are not represented.
- [ ] **Step 3 (GREEN): Implement minimal outcome mapping**
If `enqueueSyncJob` exposes enough information to distinguish an existing job, map it to `alreadyQueued`; otherwise add a small typed return value in `src/jobs/enqueue-sync-job.ts` and update only its call sites. For thrown errors in sync-all, call `captureException(error)` and return `{ providerId, status: "failed", message }`.
- [ ] **Step 4 (GREEN): Run verification**
```bash
pnpm vitest run --project unit packages/server/src/routers/sync.test.ts src/jobs/enqueue-sync-job.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit queued and failed outcome handling**
```bash
git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts src/jobs/enqueue-sync-job.ts src/jobs/enqueue-sync-job.test.ts
git commit -m "feat: distinguish queued and failed provider syncs"
```
### Task 3: Global Queue Backpressure Visibility
**Files:**
- Modify: `packages/server/src/routers/sync.ts`
- Test: `packages/server/src/routers/sync.test.ts`
- [ ] **Step 1 (RED): Add failing queue-depth test**
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
- [ ] **Step 2 (RED): Run the queue-depth test and verify the expected failure**
```bash
pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "queue depth"
```
Expected: FAIL because `activeSyncs` does not expose queue depth.
- [ ] **Step 3 (GREEN): Add queue metadata**
Extend `activeSyncs` result items with `providerId`, `queueName`, and `queueDepth`. Compute depth from the already fetched waiting, delayed, and active jobs per queue; do not add a second Redis scan if the current data is enough.
- [ ] **Step 4 (GREEN): Run server tests**
```bash
pnpm vitest run --project unit packages/server/src/routers/sync.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit queue backpressure visibility**
```bash
git add packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts
git commit -m "feat: expose sync queue backpressure"
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
- [ ] **Step 1 (RED): Add concrete web and mobile rendering tests**
In `packages/web/src/components/SyncProviderCard.test.tsx`, add test cases named:
- `renders skipped cooldown provider outcomes`: pass a Garmin `providerResults` entry with `{ providerId: "garmin", status: "skippedCooldown", message: "Provider sync skipped: rate-limit cooldown active" }` and expect `"Cooldown active"` plus the cooldown message.
- `renders failed provider outcomes`: pass a Polar `providerResults` entry with `{ providerId: "polar", status: "failed", message: "provider queue unavailable" }` and expect `"provider queue unavailable"`.
- `polls started provider jobs`: pass a Wahoo `providerResults` entry with `{ providerId: "wahoo", status: "started", jobId: "wahoo:job-wahoo", queueName: "sync-wahoo" }` and expect the existing job polling helper to receive `"wahoo:job-wahoo"`.
In `packages/mobile/app/providers/index.test.tsx`, add matching cases named:
- `renders skipped cooldown provider outcomes on mobile`: render the providers screen with the Garmin skipped result and expect `"Cooldown active"` plus the cooldown message.
- `renders failed provider outcomes on mobile`: render the providers screen with the Polar failed result and expect `"provider queue unavailable"`.
- `polls started provider jobs on mobile`: render the providers screen with the Wahoo started result and expect the mocked polling hook to receive `"wahoo:job-wahoo"`.
- [ ] **Step 2 (RED): Run UI tests and verify the expected failures**
```bash
pnpm vitest run --project unit packages/web/src/components/SyncProviderCard.test.tsx
pnpm vitest run --project mobile packages/mobile/app/providers/index.test.tsx
```
Expected: FAIL until the components consume `providerResults`.
- [ ] **Step 3 (GREEN): Implement rendering**
Map `providerResults` by `providerId`. Render `skippedCooldown`, `alreadyQueued`, and `failed` as per-provider statuses; continue polling `started` and `alreadyQueued` results with a `jobId`. Do not show disabled providers.
- [ ] **Step 4 (GREEN): Run verification**
```bash
pnpm vitest run --project unit packages/web/src/components/SyncProviderCard.test.tsx
pnpm vitest run --project mobile packages/mobile/app/providers/index.test.tsx
pnpm tsc --noEmit
```
- [ ] **Step 5 (REFACTOR): Commit provider outcome rendering**
```bash
git add packages/web/src/components/DataSourcesPanel.tsx packages/web/src/components/SyncProviderCard.tsx packages/web/src/components/SyncProviderCard.test.tsx packages/web/src/components/SyncProviderCard.stories.tsx packages/mobile/app/providers/index.tsx packages/mobile/app/providers/provider-card.tsx packages/mobile/app/providers/index.test.tsx packages/mobile/app/providers/index.stories.tsx
git commit -m "feat: render provider sync outcomes"
```
