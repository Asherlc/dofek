import { describe, expect, it, vi } from "vitest";
import { createTRPCError } from "../packages/server/src/lib/cache-warmer-test-helpers.ts";
import { requestCacheKey } from "../packages/server/src/trpc.ts";
import { MemoryCacheStore } from "../src/lib/cache.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import {
  parseRegisteredQueryCacheKey,
  warmRegisteredQueryCaches,
  warmRegisteredQueryCachesWithOutcomes,
} from "./warm-query-cache.ts";

vi.mock("../src/lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
vi.mock("../packages/server/src/router.ts", () => ({ appRouter: { createCaller: vi.fn() } }));
vi.mock("dofek/jobs/queues", () => ({
  getSharedRedisConnection: vi.fn(() => {
    throw new Error("Unit cache tests must not open Redis");
  }),
}));

describe("parseRegisteredQueryCacheKey", () => {
  it("replays a versioned pace key and overwrites its exact registered cache entry", async () => {
    const input = { days: null };
    const key = requestCacheKey(
      "user-1",
      "durationCurves.paceCurve",
      input,
      "America/Los_Angeles",
      "pace-curve-availability-v1",
    );
    expect.soft(parseRegisteredQueryCacheKey(key)).toEqual({
      key,
      userId: "user-1",
      path: "durationCurves.paceCurve",
      timezone: "America/Los_Angeles",
      input,
    });
    const cache = new MemoryCacheStore();
    await cache.set(key, "old pace", 60000);
    const replayedContexts: Array<{ userId: string; timezone: string; cacheMode: string }> = [];
    const result = await warmRegisteredQueryCaches({
      cacheStore: { listKeys: async () => [key] },
      queryCache: cache,
      db: {},
      sensorStore: {},
      getAccessWindow: async () => ({ kind: "full", paid: true, reason: "paid_grant" }),
      createCaller: (context) => {
        replayedContexts.push(context);
        return {
          durationCurves: {
            paceCurve: async (actualInput: unknown) => {
              expect(actualInput).toEqual(input);
              const actualKey = requestCacheKey(
                context.userId,
                "durationCurves.paceCurve",
                actualInput,
                context.timezone,
                "pace-curve-availability-v1",
              );
              await cache.set(actualKey, "current pace", 60000);
            },
          },
        };
      },
    });
    expect.soft(result).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect.soft(replayedContexts).toEqual([
      expect.objectContaining({
        userId: "user-1",
        timezone: "America/Los_Angeles",
        cacheMode: "refresh",
      }),
    ]);
    await expect.soft(cache.get(key)).resolves.toBe("current pace");
  });

  it("preserves the user, path, timezone, and JSON input", () => {
    expect(
      parseRegisteredQueryCacheKey(
        'user-1:cycling.activities:America/Los_Angeles:{"days":90,"activityOffset":0}',
      ),
    ).toEqual({
      key: 'user-1:cycling.activities:America/Los_Angeles:{"days":90,"activityOffset":0}',
      userId: "user-1",
      path: "cycling.activities",
      timezone: "America/Los_Angeles",
      input: { days: 90, activityOffset: 0 },
    });
  });

  it("supports cached procedures without input", () => {
    expect(
      parseRegisteredQueryCacheKey("user-1:auth.linkedAccounts:UTC:undefined")?.input,
    ).toBeUndefined();
  });

  it.each([
    { userId: "first-user", timezone: "UTC", input: undefined },
    { userId: "second-user", timezone: "Asia/Kolkata", input: null },
    { userId: "third-user", timezone: "America/Los_Angeles", input: { label: "12:30:00" } },
  ])("preserves versioned request identity for $userId", ({ userId, timezone, input }) => {
    const key = requestCacheKey(
      userId,
      "durationCurves.paceCurve",
      input,
      timezone,
      "pace-curve-availability-v1",
    );
    expect(parseRegisteredQueryCacheKey(key)).toEqual({
      key,
      userId,
      path: "durationCurves.paceCurve",
      timezone,
      input,
    });
  });
});

describe("warmRegisteredQueryCaches", () => {
  it("invokes registered procedures with their parent as the method context", async () => {
    const observedContexts: unknown[] = [];
    const queryParent = {
      expectedValue: "from-parent",
      query(this: { expectedValue: string }) {
        observedContexts.push(this);
        return Promise.resolve(this.expectedValue);
      },
    };
    const query = vi.spyOn(queryParent, "query");

    await warmRegisteredQueryCaches({
      queryCache: new MemoryCacheStore(),
      cacheStore: { listKeys: vi.fn().mockResolvedValue(["user-1:context.query:UTC:undefined"]) },
      createCaller: vi.fn().mockReturnValue({ context: queryParent }),
      getAccessWindow: vi.fn().mockResolvedValue({
        kind: "full",
        paid: true,
        reason: "paid_grant",
      }),
      db: { execute: vi.fn() },
      sensorStore: {},
    });

    expect(query).toHaveBeenCalledOnce();
    expect(observedContexts).toEqual([queryParent]);
  });

  it("replays every registered app query using refresh-mode callers", async () => {
    const performance = vi.fn().mockResolvedValue({ ok: true });
    const activities = vi.fn().mockResolvedValue({ ok: true });
    const createCaller = vi.fn().mockReturnValue({
      cycling: { performance, activities },
    });
    const listKeys = vi
      .fn()
      .mockResolvedValue([
        'user-1:cycling.performance:UTC:{"days":90}',
        'user-1:cycling.activities:UTC:{"days":90,"activityLimit":20}',
      ]);

    const result = await warmRegisteredQueryCaches({
      queryCache: new MemoryCacheStore(),
      cacheStore: { listKeys },
      createCaller,
      getAccessWindow: vi.fn().mockResolvedValue({
        kind: "full",
        paid: true,
        reason: "paid_grant",
      }),
      db: { execute: vi.fn() },
      sensorStore: {},
    });

    expect(result).toEqual({ refreshed: 2, failed: 0, skipped: 0 });
    expect(performance).toHaveBeenCalledWith({ days: 90 });
    expect(activities).toHaveBeenCalledWith({ days: 90, activityLimit: 20 });
    expect(createCaller).toHaveBeenCalledWith(expect.objectContaining({ cacheMode: "refresh" }));
  });

  it("continues warming remaining keys and reports all failures", async () => {
    const healthy = vi.fn().mockResolvedValue({ ok: true });
    const createCaller = vi.fn().mockReturnValue({
      broken: { query: vi.fn().mockRejectedValue(new Error("broken query")) },
      healthy: { query: healthy },
    });

    await expect(
      warmRegisteredQueryCaches({
        queryCache: new MemoryCacheStore(),
        cacheStore: {
          listKeys: vi
            .fn()
            .mockResolvedValue([
              'user-1:broken.query:UTC:{"days":90}',
              'user-1:healthy.query:UTC:{"days":90}',
            ]),
        },
        createCaller,
        getAccessWindow: vi.fn().mockResolvedValue({
          kind: "full",
          paid: true,
          reason: "paid_grant",
        }),
        db: { execute: vi.fn() },
        sensorStore: {},
      }),
    ).rejects.toThrow(
      "1 of 2 registered query caches failed to refresh; first failure: broken.query: broken query",
    );
    expect(healthy).toHaveBeenCalledWith({ days: 90 });
  });

  it("returns per-query outcomes for processing reconciliation", async () => {
    const result = await warmRegisteredQueryCachesWithOutcomes({
      queryCache: new MemoryCacheStore(),
      cacheStore: {
        listKeys: vi.fn().mockResolvedValue(['user-1:activity.list:UTC:{"days":30}']),
      },
      createCaller: vi.fn().mockReturnValue({
        activity: { list: vi.fn().mockResolvedValue({ ok: true }) },
      }),
      getAccessWindow: vi.fn().mockResolvedValue({
        kind: "full",
        paid: true,
        reason: "paid_grant",
      }),
      db: { execute: vi.fn() },
      sensorStore: {},
    });

    expect(result.outcomes).toEqual([
      {
        userId: "user-1",
        path: "activity.list",
        status: "succeeded",
        errorMessage: null,
      },
    ]);
  });
});

describe("unavailable cache replay", () => {
  const missingKey = "user-1:activity.stream:UTC:undefined";
  const healthyKey = "user-1:activity.list:UTC:undefined";

  async function run(error: unknown, invalidationError?: Error, failOnError = false) {
    vi.mocked(captureException).mockClear();
    const store = new MemoryCacheStore();
    await store.set(missingKey, "old stream", 60000);
    await store.set(healthyKey, "old list", 60000);
    const invalidate = vi.spyOn(store, "invalidate");
    if (invalidationError) invalidate.mockRejectedValue(invalidationError);
    const result = await warmRegisteredQueryCachesWithOutcomes(
      {
        cacheStore: { listKeys: async () => [missingKey, healthyKey] },
        queryCache: store,
        db: {},
        sensorStore: {},
        getAccessWindow: async () => ({ kind: "full", paid: true, reason: "paid_grant" }),
        createCaller: () => ({
          activity: {
            stream: async () => {
              throw error;
            },
            list: async () => {
              await store.set(healthyKey, "new list", 60000);
            },
          },
        }),
      },
      { failOnError },
    );
    return { result, store, invalidate };
  }

  it("evicts semantic NOT_FOUND replay, skips its outcome, and refreshes siblings", async () => {
    const { result, store, invalidate } = await run(createTRPCError("NOT_FOUND"));
    expect(result).toEqual({
      refreshed: 1,
      failed: 0,
      skipped: 1,
      outcomes: [
        { userId: "user-1", path: "activity.list", status: "succeeded", errorMessage: null },
      ],
    });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(missingKey);
    await expect(store.get(missingKey)).resolves.toBeUndefined();
    await expect(store.get(healthyKey)).resolves.toBe("new list");
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    new Error("ordinary failure"),
    createTRPCError("INTERNAL_SERVER_ERROR"),
    Object.assign(new Error("pretend missing"), { code: "NOT_FOUND" }),
  ])("retains old values and records genuine refresh errors: %s", async (error) => {
    const { result, store, invalidate } = await run(error);
    expect(result).toMatchObject({ refreshed: 1, failed: 1, skipped: 0 });
    expect(result.outcomes).toContainEqual({
      userId: "user-1",
      path: "activity.stream",
      status: "failed",
      errorMessage: error.message,
    });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(store.get(missingKey)).resolves.toBe("old stream");
    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
  });

  it("reports eviction failures as failures and retains the old payload", async () => {
    const { result, store } = await run(
      createTRPCError("NOT_FOUND"),
      new Error("Redis unavailable"),
    );
    expect(result).toMatchObject({ refreshed: 1, failed: 1, skipped: 0 });
    expect(result.outcomes).toContainEqual({
      userId: "user-1",
      path: "activity.stream",
      status: "failed",
      errorMessage: "Redis unavailable",
    });
    await expect(store.get(missingKey)).resolves.toBe("old stream");
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Redis unavailable" }),
      expect.any(Object),
    );
  });

  it("does not evict on NOT_FOUND from required access-window lookup", async () => {
    const invalidate = vi.fn();
    const result = await warmRegisteredQueryCachesWithOutcomes(
      {
        cacheStore: { listKeys: async () => [missingKey] },
        queryCache: { invalidate },
        db: {},
        sensorStore: {},
        getAccessWindow: async () => {
          throw createTRPCError("NOT_FOUND");
        },
        createCaller: vi.fn(),
      },
      { failOnError: false },
    );
    expect(result).toMatchObject({ refreshed: 0, failed: 1, skipped: 0 });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not reject a successfully evicted replay with failure enforcement enabled", async () => {
    const { result } = await run(createTRPCError("NOT_FOUND"), undefined, true);
    expect(result).toMatchObject({ refreshed: 1, failed: 0, skipped: 1 });
  });

  it("rejects genuine refresh and eviction failures with failure enforcement enabled", async () => {
    await expect(run(createTRPCError("INTERNAL_SERVER_ERROR"), undefined, true)).rejects.toThrow(
      "1 of 2 registered query caches failed to refresh",
    );
    await expect(
      run(createTRPCError("NOT_FOUND"), new Error("Redis unavailable"), true),
    ).rejects.toThrow("activity.stream: Redis unavailable");
  });
});
