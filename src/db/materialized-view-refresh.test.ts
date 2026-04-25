import { describe, expect, it, vi } from "vitest";
import { refreshMaterializedView } from "./materialized-view-refresh.ts";

function createDatabase(execute = vi.fn()) {
  return { execute };
}

describe("refreshMaterializedView", () => {
  it("refreshes concurrently when possible", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const db = createDatabase(execute);

    const result = await refreshMaterializedView(db, "fitness.v_daily_metrics", {
      source: "test.concurrent",
    });

    expect(result).toEqual({ fallbackUsed: false, mode: "concurrent" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to blocking refresh when concurrent refresh fails", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("concurrent refresh not possible"))
      .mockResolvedValueOnce([]);
    const db = createDatabase(execute);

    const result = await refreshMaterializedView(db, "fitness.v_daily_metrics", {
      source: "test.fallback",
    });

    expect(result).toEqual({ fallbackUsed: true, mode: "blocking" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("throws AggregateError when both refresh attempts fail", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("concurrent failed"))
      .mockRejectedValueOnce(new Error("blocking failed"));
    const db = createDatabase(execute);

    await expect(
      refreshMaterializedView(db, "fitness.v_daily_metrics", {
        source: "test.error",
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
