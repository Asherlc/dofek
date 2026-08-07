# Post-Sync Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every required post-sync maintenance failure reject so BullMQ retries it with the repository's established retry policy.

**Architecture:** Keep the existing ordered post-sync processor and make each required step fail fast after recording step-specific progress and Sentry context. Reuse `SYNC_JOB_RETRY_OPTIONS` when enqueueing post-sync jobs so a thrown processor error moves the same BullMQ job into its configured fixed-backoff retry flow. BullMQ retries processor failures only when `attempts` permits another run; see the [BullMQ retry documentation](https://docs.bullmq.io/guide/retrying-failing-jobs).

**Tech Stack:** TypeScript, BullMQ, Vitest, Sentry

## Global Constraints

- Follow TDD: demonstrate each new processor expectation failing before changing production code.
- Keep body refresh, parameter refit, and cache invalidation ordered and required.
- Preserve the original thrown error and existing `postSyncStep` Sentry tags.
- Keep progress-reporting failures non-fatal.
- Reuse `SYNC_JOB_RETRY_OPTIONS`; do not create or tune a second retry policy.
- Preserve post-sync delay, deduplication, completion removal, worker concurrency, and job payloads.
- Do not alter the internal optional-fitter behavior of `refitAllParams`.

---

## File Structure

- `src/jobs/process-post-sync-job.test.ts`: Defines success, ordering, progress, Sentry, and rejection behavior for the processor.
- `src/jobs/process-post-sync-job.ts`: Runs required maintenance in order and rejects on maintenance failure.
- `src/jobs/queues.test.ts`: Verifies both post-sync enqueue paths pass the established retry options to BullMQ.
- `src/jobs/queues.ts`: Applies the shared retry options while preserving post-sync debounce and deduplication.

### Task 1: Reject Required Maintenance Failures

**Files:**
- Modify: `src/jobs/process-post-sync-job.test.ts:103-231`
- Modify: `src/jobs/process-post-sync-job.ts:49-93`

**Interfaces:**
- Consumes: `processPostSyncJob(job, db, getSensorStore, refreshBodyMeasurements): Promise<void>`
- Produces: The same `processPostSyncJob` signature, now rejecting with the original error when body refresh, refitting, or cache invalidation fails.

- [ ] **Step 1: Replace the refit partial-success tests with one failing rejection test**

In `src/jobs/process-post-sync-job.test.ts`, remove:

```typescript
it("reports partial completion progress when user refit work has errors", async () => {
  const job = makeUserRefitJob("user-1");
  mockRefitAllParams.mockRejectedValueOnce(new Error("refit failed"));

  await processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements);

  expect(job.updateProgress).toHaveBeenCalledWith({
    percentage: 100,
    message: "Post-sync refit completed with errors.",
  });
});
```

Remove the separate `"continues when refitAllParams fails"` and `"reports errors to Sentry when refitAllParams fails"` tests. Add this single behavior-focused test:

```typescript
it("reports and rejects when personalized parameter refitting fails", async () => {
  const refitError = new Error("refit failed");
  const job = makeUserRefitJob("user-10");
  mockRefitAllParams.mockRejectedValueOnce(refitError);

  await expect(
    processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements),
  ).rejects.toBe(refitError);

  expect(mockCaptureException).toHaveBeenCalledWith(refitError, {
    tags: { postSyncStep: "refitParams" },
  });
  expect(job.updateProgress).toHaveBeenCalledWith({
    percentage: 45,
    message: "Personalized parameter refit failed; retry required.",
  });
  expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
  expect(job.updateProgress).not.toHaveBeenCalledWith({
    percentage: 100,
    message: "Post-sync refit complete.",
  });
});
```

- [ ] **Step 2: Replace the cache partial-success test with one failing rejection test**

Replace `"reports errors to Sentry when user cache invalidation fails"` with:

```typescript
it("reports and rejects when user cache invalidation fails", async () => {
  const cacheError = new Error("cache failed");
  const job = makeUserRefitJob("user-13");
  mockInvalidateByPrefix.mockRejectedValueOnce(cacheError);

  await expect(
    processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements),
  ).rejects.toBe(cacheError);

  expect(mockCaptureException).toHaveBeenCalledWith(cacheError, {
    tags: { postSyncStep: "invalidateUserCache" },
  });
  expect(job.updateProgress).toHaveBeenCalledWith({
    percentage: 75,
    message: "User cache invalidation failed; retry required.",
  });
  expect(job.updateProgress).not.toHaveBeenCalledWith({
    percentage: 100,
    message: "Post-sync refit complete.",
  });
});
```

- [ ] **Step 3: Extend the existing body-refresh rejection test**

After its current Sentry assertion, add:

```typescript
expect(job.updateProgress).toHaveBeenCalledWith({
  percentage: 20,
  message: "Body measurement refresh failed; retry required.",
});
```

Change that test to create `const job = makeUserRefitJob("user-11");` before the `expect` and pass `job` into `processPostSyncJob`.

- [ ] **Step 4: Run the focused processor tests and verify the new tests fail**

Run:

```bash
pnpm vitest run src/jobs/process-post-sync-job.test.ts --project unit
```

Expected: FAIL because refit and cache errors resolve rather than reject, failure progress is absent, and the obsolete 100% `"completed with errors"` message is still emitted.

- [ ] **Step 5: Make all required steps report failure and rethrow**

In `src/jobs/process-post-sync-job.ts`, remove `let completedWithErrors = false;`.

Change the body-refresh catch to:

```typescript
} catch (error) {
  logger.error(`[post-sync] Failed to refresh body measurement read model: ${error}`);
  Sentry.captureException(error, {
    tags: { postSyncStep: "refreshBodyMeasurements" },
  });
  await updatePostSyncProgress(
    job,
    20,
    "Body measurement refresh failed; retry required.",
  );
  throw error;
}
```

Change the refit catch to:

```typescript
} catch (error) {
  logger.error(`[post-sync] Failed to refit parameters: ${error}`);
  Sentry.captureException(error, { tags: { postSyncStep: "refitParams" } });
  await updatePostSyncProgress(
    job,
    45,
    "Personalized parameter refit failed; retry required.",
  );
  throw error;
}
```

Change the cache-invalidation catch to:

```typescript
} catch (error) {
  logger.error(`[post-sync] Failed to invalidate cache for user ${job.data.userId}: ${error}`);
  Sentry.captureException(error, {
    tags: { postSyncStep: "invalidateUserCache" },
  });
  await updatePostSyncProgress(
    job,
    75,
    "User cache invalidation failed; retry required.",
  );
  throw error;
}
```

Replace the conditional terminal progress call with:

```typescript
await updatePostSyncProgress(job, 100, "Post-sync refit complete.");
```

- [ ] **Step 6: Run the focused processor tests and verify they pass**

Run:

```bash
pnpm vitest run src/jobs/process-post-sync-job.test.ts --project unit
```

Expected: PASS. The refit and cache tests reject with the original error, failure progress and Sentry context are present, and successful jobs still reach 100%.

- [ ] **Step 7: Commit the processor behavior**

```bash
git add src/jobs/process-post-sync-job.ts src/jobs/process-post-sync-job.test.ts
git commit -m "fix: reject failed post-sync maintenance"
```

### Task 2: Configure BullMQ Retries for Post-Sync Jobs

**Files:**
- Modify: `src/jobs/queues.test.ts:608-652`
- Modify: `src/jobs/queues.ts:541-577`

**Interfaces:**
- Consumes: `SYNC_JOB_RETRY_OPTIONS` with `attempts: 288`, fixed `300_000` millisecond backoff, and failed-job retention.
- Produces: Unchanged `enqueueDebouncedPostSyncMaintenance(queue?): Promise<void>` and `enqueueDebouncedUserRefit(userId, queue?): Promise<void>` signatures whose BullMQ options include the shared retry policy.

- [ ] **Step 1: Add retry options to both queue expectations**

In the expected options object for `"adds one delayed deduplicated global maintenance job"`, add:

```typescript
attempts: 288,
backoff: { type: "fixed", delay: 300_000 },
removeOnFail: { age: 604_800, count: 1_000 },
```

Keep `removeOnComplete: true`, `delay`, and `deduplication` unchanged.

Add the same three properties to the expected options object for `"adds one delayed deduplicated per-user refit job"`.

- [ ] **Step 2: Run the focused queue tests and verify they fail**

Run:

```bash
pnpm vitest run src/jobs/queues.test.ts --project unit
```

Expected: FAIL because both `queue.add` calls omit `attempts`, `backoff`, and `removeOnFail`.

- [ ] **Step 3: Reuse the established retry options in both enqueue paths**

In `enqueueDebouncedPostSyncMaintenance`, make the options object begin with the shared policy:

```typescript
{
  ...SYNC_JOB_RETRY_OPTIONS,
  delay: POST_SYNC_DEBOUNCE_MS,
  deduplication: {
    id: GLOBAL_POST_SYNC_DEDUPLICATION_ID,
    ttl: POST_SYNC_DEBOUNCE_MS,
    extend: true,
    replace: true,
  },
  removeOnComplete: true,
}
```

In `enqueueDebouncedUserRefit`, use:

```typescript
{
  ...SYNC_JOB_RETRY_OPTIONS,
  delay: POST_SYNC_DEBOUNCE_MS,
  deduplication: {
    id: `post-sync:user-refit:${userId}`,
    ttl: POST_SYNC_DEBOUNCE_MS,
    extend: true,
    replace: true,
  },
  removeOnComplete: true,
}
```

Placing `removeOnComplete: true` after the spread preserves the current post-sync completion-removal behavior while inheriting attempts, backoff, and failed-job retention.

- [ ] **Step 4: Run the focused queue tests and verify they pass**

Run:

```bash
pnpm vitest run src/jobs/queues.test.ts --project unit
```

Expected: PASS.

- [ ] **Step 5: Run affected and repository-level verification**

Run:

```bash
pnpm vitest run src/jobs/process-post-sync-job.test.ts src/jobs/queues.test.ts --project unit
pnpm test:changed
pnpm typecheck
pnpm lint
```

Expected: all commands exit successfully with no failed tests, TypeScript errors, or lint diagnostics.

- [ ] **Step 6: Commit the queue retry configuration**

```bash
git add src/jobs/queues.ts src/jobs/queues.test.ts
git commit -m "fix: retry post-sync jobs"
```
