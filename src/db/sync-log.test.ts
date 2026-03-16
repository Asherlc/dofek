import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncLogEntry } from "./sync-log.ts";
import { logSync, withSyncLog } from "./sync-log.ts";

// Create a mock DB with an insert chain
function createMockDb() {
  const valuesFn = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn(() => ({ values: valuesFn }));
  return {
    insert: insertFn,
    _valuesFn: valuesFn,
    _insertFn: insertFn,
  };
}

// We need to type this loosely since Database is a complex drizzle type
type MockDb = ReturnType<typeof createMockDb>;

describe("logSync", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it("inserts a success log entry with all fields", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      recordCount: 42,
      durationMs: 1500,
    };

    // @ts-expect-error mock DB
    await logSync(mockDb, entry);

    expect(mockDb._insertFn).toHaveBeenCalled();
    expect(mockDb._valuesFn).toHaveBeenCalledWith({
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

    // @ts-expect-error mock DB
    await logSync(mockDb, entry);

    expect(mockDb._valuesFn).toHaveBeenCalledWith({
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

    // @ts-expect-error mock DB
    await logSync(mockDb, entry);

    expect(mockDb._valuesFn).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 0 }));
  });
});

describe("withSyncLog", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs success and returns the result on success", async () => {
    const fn = vi.fn().mockResolvedValue({ recordCount: 10, result: "data" });

    // @ts-expect-error mock DB
    const result = await withSyncLog(mockDb, "wahoo", "activities", fn);

    expect(result).toBe("data");
    expect(fn).toHaveBeenCalled();
    expect(mockDb._valuesFn).toHaveBeenCalledWith(
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

    await expect(
      // @ts-expect-error mock DB
      withSyncLog(mockDb, "whoop", "sleep", fn),
    ).rejects.toThrow("sync failed");

    expect(mockDb._valuesFn).toHaveBeenCalledWith(
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

    await expect(
      // @ts-expect-error mock DB
      withSyncLog(mockDb, "wahoo", "body", fn),
    ).rejects.toBe("string error");

    expect(mockDb._valuesFn).toHaveBeenCalledWith(
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

    // @ts-expect-error mock DB
    await withSyncLog(mockDb, "wahoo", "activities", fn);

    expect(mockDb._valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 500,
      }),
    );
  });
});

// Need afterEach import
import { afterEach } from "vitest";
