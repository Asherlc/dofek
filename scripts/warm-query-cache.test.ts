import { describe, expect, it, vi } from "vitest";
import {
  parseRegisteredQueryCacheKey,
  warmRegisteredQueryCaches,
  warmRegisteredQueryCachesWithOutcomes,
} from "./warm-query-cache.ts";

describe("parseRegisteredQueryCacheKey", () => {
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
