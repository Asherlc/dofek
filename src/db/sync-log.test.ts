import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import type { SyncLogEntry } from "./sync-log.ts";
import { logSync, PartialSyncError, withSyncLog } from "./sync-log.ts";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("dofek/lib/error-reporting", () => ({ captureException }));

describe("logSync", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    captureException.mockReset();
    db = createMockDatabase();
  });

  it("alerts when a scheduled provider reaches two consecutive top-level failures", async () => {
    db = createMockDatabase({ executeResult: [{ consecutive_failures: "2" }] });

    await logSync(db.db, {
      providerId: "amazfit-zepp",
      dataType: "sync",
      status: "error",
      errorMessage: "access token expired",
      userId: "user-123",
      origin: "scheduled",
    });

    expect(db.spies.execute).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: {
        error_message: "access token expired",
        user_id: "user-123",
      },
      level: "warning",
      tags: {
        consecutive_failures: "2",
        operation: "scheduled-provider-sync",
        provider: "amazfit-zepp",
      },
    });
  });

  it("does not alert before or after the consecutive-failure threshold", async () => {
    for (const consecutiveFailures of [1, 3]) {
      db = createMockDatabase({
        executeResult: [{ consecutive_failures: String(consecutiveFailures) }],
      });

      await logSync(db.db, {
        providerId: "whoop",
        dataType: "sync",
        status: "error",
        userId: "user-123",
        origin: "scheduled",
      });
    }

    expect(captureException).not.toHaveBeenCalled();
  });

  it("inserts a success log entry with all fields", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      recordCount: 42,
      durationMs: 1500,
      userId: "user-123",
      origin: "manual",
    };

    await logSync(db.db, entry);

    expect(db.spies.insert).toHaveBeenCalled();
    expect(db.spies.values).toHaveBeenCalledWith({
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      recordCount: 42,
      errorMessage: undefined,
      authFailureReason: undefined,
      degradationKind: undefined,
      durationMs: 1500,
      userId: "user-123",
      origin: "manual",
    });
  });

  it("inserts an error log entry with error message", async () => {
    const entry: SyncLogEntry = {
      providerId: "whoop",
      dataType: "sleep",
      status: "error",
      errorMessage: "API timeout",
      durationMs: 5000,
      userId: "user-456",
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith({
      providerId: "whoop",
      dataType: "sleep",
      status: "error",
      recordCount: 0,
      errorMessage: "API timeout",
      authFailureReason: undefined,
      degradationKind: undefined,
      durationMs: 5000,
      userId: "user-456",
      origin: "unknown",
    });
  });

  it("inserts a structured auth failure reason", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "sync",
      status: "error",
      errorMessage: "Wahoo access token expired.",
      authFailureReason: "access_token_expired",
      userId: "user-123",
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        authFailureReason: "access_token_expired",
      }),
    );
  });

  it("inserts a degraded log entry with degradation kind", async () => {
    const entry: SyncLogEntry = {
      providerId: "whoop",
      dataType: "developer_workouts",
      status: "degraded",
      recordCount: 25,
      degradationKind: "pagination_stalled",
      errorMessage: "WHOOP returned a repeated workout cursor",
      userId: "user-123",
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith({
      providerId: "whoop",
      dataType: "developer_workouts",
      status: "degraded",
      recordCount: 25,
      errorMessage: "WHOOP returned a repeated workout cursor",
      authFailureReason: undefined,
      degradationKind: "pagination_stalled",
      durationMs: undefined,
      userId: "user-123",
      origin: "unknown",
    });
  });

  it("defaults recordCount to 0 when not provided", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      userId: "user-123",
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 0 }));
  });

  it("preserves non-zero recordCount", async () => {
    const entry: SyncLogEntry = {
      providerId: "wahoo",
      dataType: "activities",
      status: "success",
      recordCount: 15,
      userId: "user-123",
    };

    await logSync(db.db, entry);

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 15 }));
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

    const result = await withSyncLog(db.db, "wahoo", "activities", fn, "user-123");

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

  it("logs degraded when the operation returns a degradation", async () => {
    const fn = vi.fn().mockResolvedValue({
      recordCount: 10,
      result: "data",
      degradations: [
        {
          kind: "pagination_stalled",
          providerId: "whoop",
          stepName: "developer_workouts",
          message: "WHOOP returned a repeated workout cursor",
        },
      ],
    });

    const result = await withSyncLog(db.db, "whoop", "developer_workouts", fn, "user-123");

    expect(result).toBe("data");
    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "whoop",
        dataType: "developer_workouts",
        status: "degraded",
        recordCount: 10,
        errorMessage: "WHOOP returned a repeated workout cursor",
        degradationKind: "pagination_stalled",
      }),
    );
  });

  it("logs error and re-throws on failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("sync failed"));

    await expect(withSyncLog(db.db, "whoop", "sleep", fn, "user-123")).rejects.toThrow(
      "sync failed",
    );

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "whoop",
        dataType: "sleep",
        status: "error",
        errorMessage: "sync failed",
        authFailureReason: undefined,
      }),
    );
  });

  it("logs partial record counts on partial sync failure", async () => {
    const cause = new Error("page failed");
    const fn = vi.fn().mockRejectedValue(new PartialSyncError("activity: page failed", 3, cause));

    await expect(withSyncLog(db.db, "komoot", "activity", fn, "user-123")).rejects.toThrow(
      "activity: page failed",
    );

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "komoot",
        dataType: "activity",
        status: "error",
        recordCount: 3,
        errorMessage: "activity: page failed",
      }),
    );
  });

  it("logs non-Error exceptions as strings", async () => {
    const fn = vi.fn().mockRejectedValue("string error");

    await expect(withSyncLog(db.db, "wahoo", "body", fn, "user-123")).rejects.toBe("string error");

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

    await withSyncLog(db.db, "wahoo", "activities", fn, "user-123");

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 500,
      }),
    );
  });

  it("records durationMs for error path", async () => {
    vi.setSystemTime(new Date("2026-03-15T10:00:00Z"));

    const fn = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(300);
      throw new Error("timeout");
    });

    await expect(withSyncLog(db.db, "whoop", "sleep", fn, "user-123")).rejects.toThrow("timeout");

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        durationMs: 300,
      }),
    );
  });

  it("passes correct providerId and dataType on success", async () => {
    const fn = vi.fn().mockResolvedValue({ recordCount: 0, result: null });

    await withSyncLog(db.db, "strava", "body_composition", fn, "user-123");

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "strava",
        dataType: "body_composition",
        status: "success",
      }),
    );
  });
});
