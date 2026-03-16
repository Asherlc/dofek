import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import type { SyncLogEntry } from "./sync-log.ts";
import { logSync, withSyncLog } from "./sync-log.ts";

describe("logSync", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
  });

  it("inserts a success log entry with all fields", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      recordCount: 42,
      durationMs: 1500,
    };

    await logSync(db.db, entry);

    expect(db.spies.insert).toHaveBeenCalled();
    expect(db.spies.values).toHaveBeenCalledWith({
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      recordCount: 42,
      errorMessage: undefined,
      durationMs: 1500,
    });
  });

  it("inserts an error log entry with error message", async () => {
    const entry: SyncLogEntry = {
      providerId: "whoop",
      dataType: "sleep",
      status: "error",
      errorMessage: "API timeout",
      durationMs: 5000,
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith({
      providerId: "whoop",
      dataType: "sleep",
      status: "error",
      recordCount: 0,
      errorMessage: "API timeout",
      durationMs: 5000,
    });
  });

  it("defaults recordCount to 0 when not provided", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 0 }));
  });
});

describe("withSyncLog", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs success and returns the result on success", async () => {
    const fn = vi.fn().mockResolvedValue({ recordCount: 10, result: "data" });

    const result = await withSyncLog(db.db, "wahoo", "activities", fn);

    expect(result).toBe("data");
    expect(fn).toHaveBeenCalled();
    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "wahoo",
        dataType: "activities",
        status: "success",
        recordCount: 10,
      }),
    );
  });

  it("logs error and re-throws on failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("sync failed"));

    await expect(withSyncLog(db.db, "whoop", "sleep", fn)).rejects.toThrow("sync failed");

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "whoop",
        dataType: "sleep",
        status: "error",
        errorMessage: "sync failed",
      }),
    );
  });

  it("logs non-Error exceptions as strings", async () => {
    const fn = vi.fn().mockRejectedValue("string error");

    await expect(withSyncLog(db.db, "wahoo", "body", fn)).rejects.toBe("string error");

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "string error",
      }),
    );
  });

  it("records durationMs in both success and error logs", async () => {
    vi.setSystemTime(new Date("2026-03-15T10:00:00Z"));

    const fn = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(500);
      return { recordCount: 1, result: "ok" };
    });

    await withSyncLog(db.db, "wahoo", "activities", fn);

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 500,
      }),
    );
  });
});
