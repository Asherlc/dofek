import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./telemetry";
import { WhoopBleDiagnostics } from "./whoop-ble-diagnostics";
import { makeWhoopCaptureStats } from "./whoop-ble-test-helpers";

vi.mock("expo-crypto", () => ({
  randomUUID: () => "22222222-2222-4222-8222-222222222222",
}));
vi.mock("./telemetry", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("WhoopBleDiagnostics", () => {
  it("replays unseen native events once with native time, flat metadata and unknown account provenance", () => {
    const diagnostics = new WhoopBleDiagnostics();
    const stats = makeWhoopCaptureStats();
    const event = {
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-10-23T01:00:00.000Z",
      nativeSessionId: "22222222-2222-4222-8222-222222222222",
      processId: 4321,
      event: "disconnected",
      connectionState: "streaming",
      centralState: "poweredOn",
      reconnectIntent: true,
      errorDomain: "CBErrorDomain",
      errorCode: 6,
      errorDescription: "Connection lost",
    };
    Object.assign(stats, { connectionDiagnostics: { events: [event], overflowCount: 3 } });
    Object.assign(event, { sensorValue: "private-sample", credentials: "private-credential" });
    diagnostics.snapshot(stats, "initial", "background");
    diagnostics.snapshot(stats, "periodic", "active");
    Object.assign(stats, {
      connectionDiagnostics: {
        events: [
          event,
          { ...event, eventId: "33333333-3333-4333-8333-333333333333", event: "central_state" },
        ],
        overflowCount: 3,
      },
    });
    diagnostics.snapshot(stats, "periodic", "active");
    const logs = vi
      .mocked(logger.info)
      .mock.calls.filter(([, message]) => message === "native_connection_event");
    expect(logs).toHaveLength(2);
    expect(logs[0]?.[2]).toMatchObject({
      event: "native_connection_event",
      nativeEvent: "disconnected",
      nativeOccurredAt: event.occurredAt,
      nativeSessionId: event.nativeSessionId,
      processId: 4321,
      eventId: event.eventId,
      connectionAccountProvenance: "unknown",
      connectionHistoryOverflowCount: 3,
      errorDomain: "CBErrorDomain",
      errorCode: 6,
    });
    expect(JSON.stringify(logs)).not.toContain("private-");
    expect(
      Object.values(logs[0]?.[2] ?? {}).every(
        (value) => value == null || ["string", "number", "boolean"].includes(typeof value),
      ),
    ).toBe(true);
    new WhoopBleDiagnostics().snapshot(stats, "initial", "active");
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.filter(([, message]) => message === "native_connection_event"),
    ).toHaveLength(4);
  });

  it("reports capture, queue ranges, counters and prior checkpoint once per buffer instance", () => {
    const stats = makeWhoopCaptureStats();
    Object.assign(stats, { lastCommandResponse: "private-native-response" });
    Object.assign(stats.buffers.realtime, { opticalRawHex: "private-buffer-response" });
    stats.dataNotificationCount = 400;
    stats.lastValidHeartRateAt = "2026-10-23T00:59:58.000Z";
    stats.buffers.realtime.count = 90;
    stats.buffers.realtime.oldestTimestamp = "2026-10-23T00:58:30.000Z";
    stats.buffers.realtime.newestTimestamp = "2026-10-23T00:59:59.000Z";
    stats.buffers.realtime.overflowDiscardedCount = 12;
    stats.buffers.previousCheckpoint = {
      ...stats.buffers,
      bufferInstanceId: "33333333-3333-4333-8333-333333333333",
    };
    const diagnostics = new WhoopBleDiagnostics();

    diagnostics.snapshot(stats, "initial", "active");
    diagnostics.snapshot(stats, "periodic", "active");

    expect(logger.info).toHaveBeenCalledWith(
      "whoop-ble",
      "capture_snapshot",
      expect.objectContaining({
        event: "capture_snapshot",
        bufferInstanceId: stats.buffers.bufferInstanceId,
        dataNotificationCount: 400,
        lastValidHeartRateAt: "2026-10-23T00:59:58.000Z",
        realtimeCount: 90,
        realtimeOldestTimestamp: "2026-10-23T00:58:30.000Z",
        realtimeNewestTimestamp: "2026-10-23T00:59:59.000Z",
        realtimeOverflowDiscardedCount: 12,
      }),
    );
    const checkpoints = vi
      .mocked(logger.info)
      .mock.calls.filter(([, message]) => message === "previous_buffer_checkpoint");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.[2]).toMatchObject({
      previousBufferInstanceId: "33333333-3333-4333-8333-333333333333",
      checkpointAccountProvenance: "unknown",
      previousRealtimeCount: 90,
    });
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      "private-native-response",
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      "private-buffer-response",
    );
  });

  it("reports pending request age separately from worker age and correlates upload outcomes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T01:00:00Z"));
    const diagnostics = new WhoopBleDiagnostics();
    const stats = makeWhoopCaptureStats();
    diagnostics.snapshot(stats, "initial", "active");
    diagnostics.workerStarted("imu", "initial");
    vi.advanceTimersByTime(1000);
    const batch = diagnostics.uploadStarted("imu", "whoop-a", [
      { timestamp: "2026-10-23T00:00:02.000Z" },
      { timestamp: "2026-10-23T00:00:01.000Z" },
    ]);
    vi.advanceTimersByTime(2000);
    diagnostics.snapshot(stats, "periodic", "active");

    expect(batch.telemetry).toEqual({
      batchId: "22222222-2222-4222-8222-222222222222",
      bufferInstanceId: stats.buffers.bufferInstanceId,
    });
    expect(logger.info).toHaveBeenLastCalledWith(
      "whoop-ble",
      "capture_snapshot",
      expect.objectContaining({
        imuWorkerAgeMs: 3000,
        imuPendingRequestAgeMs: 2000,
        imuPendingBatchId: batch.telemetry.batchId,
      }),
    );
    diagnostics.uploadAcknowledged(batch, 6);
    diagnostics.bufferConfirmed("imu", [batch], 2, 0);
    diagnostics.workerFinished("imu");
    expect(logger.info).toHaveBeenCalledWith(
      "whoop-ble",
      "upload_acknowledged",
      expect.objectContaining({
        batchId: batch.telemetry.batchId,
        firstTimestamp: "2026-10-23T00:00:01.000Z",
        lastTimestamp: "2026-10-23T00:00:02.000Z",
        publishedRowCount: 6,
        sampleCount: 2,
        elapsedMs: 2000,
      }),
    );
    diagnostics.snapshot(stats, "periodic", "active");
    expect(logger.info).toHaveBeenLastCalledWith(
      "whoop-ble",
      "capture_snapshot",
      expect.objectContaining({ imuWorkerActive: false, imuRequestPending: false }),
    );
  });

  it("records failed uploads and skipped decisions without copying samples or error messages", () => {
    const diagnostics = new WhoopBleDiagnostics();
    const batch = diagnostics.uploadStarted("realtime", "whoop-a", [
      { timestamp: "2026-10-23T00:00:00.000Z", heartRateBpm: 75 },
    ]);
    diagnostics.uploadFailed(batch, new Error("private response body"));
    diagnostics.skipped("realtime", "app_inactive", "periodic");

    expect(logger.warn).toHaveBeenCalledWith(
      "whoop-ble",
      "upload_failed",
      expect.objectContaining({ batchId: batch.telemetry.batchId, errorName: "Error" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "whoop-ble",
      "upload_skipped",
      expect.objectContaining({ stream: "realtime", reason: "app_inactive", trigger: "periodic" }),
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "private response body",
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("heartRateBpm");
  });
});
