import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingTrpcClient } from "./activity-recording.ts";
import { type ActivityRecorder, createActivityRecorder } from "./activity-recording.ts";
import type { InertialMeasurementUnitService } from "./inertial-measurement-unit-service.ts";

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

afterEach(() => {
  vi.useRealTimers();
});

function makeMockTrpcClient(): RecordingTrpcClient {
  return {
    activityRecording: {
      save: {
        mutate: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
      },
    },
  };
}

function makeMockSensorService(): InertialMeasurementUnitService {
  return {
    ensureRecording: vi.fn().mockResolvedValue(undefined),
    syncForTimeRange: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createActivityRecorder", () => {
  let trpcClient: RecordingTrpcClient;
  let sensorService: InertialMeasurementUnitService;
  let recorder: ActivityRecorder;

  beforeEach(() => {
    trpcClient = makeMockTrpcClient();
    sensorService = makeMockSensorService();
    recorder = createActivityRecorder(trpcClient, "Dofek iOS", sensorService);
  });

  it("starts in idle state", () => {
    expect(recorder.getSnapshot()).toEqual({
      state: "idle",
      activityType: null,
      elapsedMs: 0,
      error: null,
    });
  });

  it("starts a sensor recording without requesting location", async () => {
    await recorder.start("running");

    expect(recorder.getSnapshot()).toMatchObject({
      state: "recording",
      activityType: "running",
    });
    expect(sensorService.ensureRecording).toHaveBeenCalledOnce();
  });

  it("pauses and resumes recording", async () => {
    await recorder.start("running");
    recorder.pause();

    expect(recorder.getSnapshot().state).toBe("paused");

    await recorder.resume();

    expect(recorder.getSnapshot().state).toBe("recording");
  });

  it("excludes paused time from elapsed recording time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2024-06-15T08:00:00.000Z");
    await recorder.start("running");

    vi.setSystemTime("2024-06-15T08:01:00.000Z");
    recorder.pause();
    vi.setSystemTime("2024-06-15T08:03:00.000Z");
    await recorder.resume();
    vi.setSystemTime("2024-06-15T08:04:00.000Z");
    recorder.stop();

    expect(recorder.getSnapshot().elapsedMs).toBe(2 * 60 * 1000);
  });

  it("stops recording and transitions to saving", async () => {
    await recorder.start("hiking");
    recorder.stop();

    expect(recorder.getSnapshot().state).toBe("saving");
  });

  it("saves the activity and sensor time range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2024-06-15T08:00:00.000Z");
    await recorder.start("running");
    vi.setSystemTime("2024-06-15T08:04:00.000Z");
    recorder.stop();

    const activityId = await recorder.save("Morning run", "Felt good");

    expect(activityId).toBe("activity-123");
    expect(trpcClient.activityRecording.save.mutate).toHaveBeenCalledWith({
      activityType: "running",
      startedAt: "2024-06-15T08:00:00.000Z",
      endedAt: "2024-06-15T08:04:00.000Z",
      name: "Morning run",
      notes: "Felt good",
      sourceName: "Dofek iOS",
    });
    expect(sensorService.syncForTimeRange).toHaveBeenCalledWith(
      "2024-06-15T08:00:00.000Z",
      "2024-06-15T08:04:00.000Z",
    );
    expect(recorder.getSnapshot().state).toBe("idle");
  });

  it("transitions to error on save failure", async () => {
    vi.mocked(trpcClient.activityRecording.save.mutate).mockRejectedValue(new Error("Network error"));
    await recorder.start("running");
    recorder.stop();

    await expect(recorder.save(null, null)).rejects.toThrow("Network error");

    expect(recorder.getSnapshot()).toMatchObject({
      state: "error",
      error: "Network error",
    });
  });

  it("reports sensor-start errors without interrupting activity recording", async () => {
    const sensorError = new Error("IMU error");
    vi.mocked(sensorService.ensureRecording).mockRejectedValue(sensorError);

    await recorder.start("running");

    expect(recorder.getSnapshot().state).toBe("recording");
    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(sensorError, {
        source: "activity-recording",
      });
    });
  });

  it("reports sensor-sync errors without losing the saved activity", async () => {
    const syncError = new Error("Sync failed");
    vi.mocked(sensorService.syncForTimeRange).mockRejectedValue(syncError);
    await recorder.start("cycling");
    recorder.stop();

    await expect(recorder.save(null, null)).resolves.toBe("activity-123");
    expect(recorder.getSnapshot().state).toBe("idle");
    expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
      source: "activity-recording.syncForTimeRange",
    });
  });

  it("discards a recording and resets state", async () => {
    await recorder.start("running");
    recorder.discard();

    expect(recorder.getSnapshot()).toEqual({
      state: "idle",
      activityType: null,
      elapsedMs: 0,
      error: null,
    });
  });

  it("notifies subscribers and supports unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = recorder.onUpdate(listener);

    await recorder.start("running");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    listener.mockClear();
    recorder.pause();
    expect(listener).not.toHaveBeenCalled();
  });
});
