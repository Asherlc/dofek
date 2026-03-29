import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createActivityRecorder,
  haversineDistance,
  totalDistance,
  type ActivityRecorder,
} from "./activity-recording.ts";
import type { GpsSample, LocationAdapter } from "./location-service.ts";
import type { RecordingTrpcClient } from "./activity-recording.ts";
import type { InertialMeasurementUnitService } from "./inertial-measurement-unit-service.ts";

function makeMockLocationAdapter(): LocationAdapter & {
  emitSample(sample: GpsSample): void;
} {
  let callback: ((sample: GpsSample) => void) | null = null;

  return {
    requestPermissions: vi.fn().mockResolvedValue(true),
    startUpdates: vi.fn().mockImplementation(async (cb) => {
      callback = cb;
    }),
    stopUpdates: vi.fn().mockImplementation(async () => {
      callback = null;
    }),
    emitSample(sample: GpsSample) {
      if (callback) callback(sample);
    },
  };
}

function makeMockTrpcClient(): RecordingTrpcClient {
  return {
    activityRecording: {
      save: {
        mutate: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
      },
    },
  };
}

function makeSample(overrides: Partial<GpsSample> = {}): GpsSample {
  return {
    recordedAt: "2024-06-15T08:00:00Z",
    lat: 40.7128,
    lng: -74.006,
    gpsAccuracy: 5,
    altitude: 10,
    speed: 3.5,
    ...overrides,
  };
}

describe("haversineDistance", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistance(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
  });

  it("computes distance between NYC and nearby point", () => {
    // ~111m per 0.001 degree latitude
    const distance = haversineDistance(40.7128, -74.006, 40.7138, -74.006);
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(120);
  });
});

describe("totalDistance", () => {
  it("returns 0 for empty or single-point arrays", () => {
    expect(totalDistance([])).toBe(0);
    expect(totalDistance([makeSample()])).toBe(0);
  });

  it("sums distances between consecutive points", () => {
    const samples = [
      makeSample({ lat: 40.7128, lng: -74.006 }),
      makeSample({ lat: 40.7138, lng: -74.006 }),
      makeSample({ lat: 40.7148, lng: -74.006 }),
    ];
    const distance = totalDistance(samples);
    // Should be roughly 2x ~111m
    expect(distance).toBeGreaterThan(200);
    expect(distance).toBeLessThan(240);
  });
});

describe("createActivityRecorder", () => {
  let location: ReturnType<typeof makeMockLocationAdapter>;
  let trpc: RecordingTrpcClient;
  let recorder: ActivityRecorder;

  beforeEach(() => {
    location = makeMockLocationAdapter();
    trpc = makeMockTrpcClient();
    recorder = createActivityRecorder(location, trpc, "Dofek iOS");
  });

  it("starts in idle state", () => {
    const snap = recorder.getSnapshot();
    expect(snap.state).toBe("idle");
    expect(snap.activityType).toBeNull();
    expect(snap.samples).toHaveLength(0);
    expect(snap.elapsedMs).toBe(0);
    expect(snap.distanceMeters).toBe(0);
  });

  it("transitions to recording on start", async () => {
    await recorder.start("running");

    const snap = recorder.getSnapshot();
    expect(snap.state).toBe("recording");
    expect(snap.activityType).toBe("running");
    expect(location.requestPermissions).toHaveBeenCalled();
    expect(location.startUpdates).toHaveBeenCalled();
  });

  it("transitions to error when permissions denied", async () => {
    location.requestPermissions = vi.fn().mockResolvedValue(false);

    await recorder.start("running");

    const snap = recorder.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.error).toContain("permissions");
  });

  it("collects GPS samples during recording", async () => {
    await recorder.start("cycling");

    location.emitSample(makeSample({ lat: 40.7128, lng: -74.006 }));
    location.emitSample(makeSample({ lat: 40.7138, lng: -74.006 }));

    const snap = recorder.getSnapshot();
    expect(snap.samples).toHaveLength(2);
    expect(snap.distanceMeters).toBeGreaterThan(0);
  });

  it("pauses and resumes recording", async () => {
    await recorder.start("running");
    location.emitSample(makeSample());

    recorder.pause();
    expect(recorder.getSnapshot().state).toBe("paused");
    expect(location.stopUpdates).toHaveBeenCalled();

    // Samples emitted during pause should not be collected
    location.emitSample(makeSample({ lat: 40.0, lng: -74.0 }));
    expect(recorder.getSnapshot().samples).toHaveLength(1);

    await recorder.resume();
    expect(recorder.getSnapshot().state).toBe("recording");
    expect(location.startUpdates).toHaveBeenCalledTimes(2);
  });

  it("stops recording and transitions to saving", async () => {
    await recorder.start("hiking");
    location.emitSample(makeSample());

    recorder.stop();

    const snap = recorder.getSnapshot();
    expect(snap.state).toBe("saving");
    expect(location.stopUpdates).toHaveBeenCalled();
    expect(snap.samples).toHaveLength(1); // samples preserved
  });

  it("saves the activity via tRPC", async () => {
    await recorder.start("running");
    location.emitSample(makeSample());
    recorder.stop();

    const activityId = await recorder.save("Morning run", "Felt good");

    expect(activityId).toBe("activity-123");
    expect(trpc.activityRecording.save.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        activityType: "running",
        name: "Morning run",
        notes: "Felt good",
        sourceName: "Dofek iOS",
        samples: expect.arrayContaining([
          expect.objectContaining({
            lat: 40.7128,
            lng: -74.006,
          }),
        ]),
      }),
    );

    // Resets to idle after save
    expect(recorder.getSnapshot().state).toBe("idle");
    expect(recorder.getSnapshot().samples).toHaveLength(0);
  });

  it("transitions to error on save failure", async () => {
    (trpc.activityRecording.save.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    await recorder.start("running");
    location.emitSample(makeSample());
    recorder.stop();

    await expect(recorder.save(null, null)).rejects.toThrow("Network error");

    const snap = recorder.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.error).toBe("Network error");
  });

  it("discards recording and resets state", async () => {
    await recorder.start("running");
    location.emitSample(makeSample());

    recorder.discard();

    const snap = recorder.getSnapshot();
    expect(snap.state).toBe("idle");
    expect(snap.samples).toHaveLength(0);
    expect(snap.activityType).toBeNull();
    expect(location.stopUpdates).toHaveBeenCalled();
  });

  it("notifies listeners on state changes", async () => {
    const listener = vi.fn();
    recorder.onUpdate(listener);

    await recorder.start("running");
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    location.emitSample(makeSample());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes listeners correctly", async () => {
    const listener = vi.fn();
    const unsub = recorder.onUpdate(listener);

    unsub();
    await recorder.start("running");
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores start when not idle", async () => {
    await recorder.start("running");
    await recorder.start("cycling"); // should be ignored

    expect(recorder.getSnapshot().activityType).toBe("running");
  });

  it("ignores pause when not recording", () => {
    recorder.pause(); // idle -> should do nothing
    expect(recorder.getSnapshot().state).toBe("idle");
  });
});

function makeMockImuService(): InertialMeasurementUnitService {
  return {
    ensureRecording: vi.fn().mockResolvedValue(undefined),
    syncForTimeRange: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createActivityRecorder with IMU service", () => {
  let location: ReturnType<typeof makeMockLocationAdapter>;
  let trpcClient: RecordingTrpcClient;
  let imuService: InertialMeasurementUnitService;
  let recorder: ActivityRecorder;

  beforeEach(() => {
    location = makeMockLocationAdapter();
    trpcClient = makeMockTrpcClient();
    imuService = makeMockImuService();
    recorder = createActivityRecorder(location, trpcClient, "Dofek iOS", imuService);
  });

  it("calls ensureRecording on start", async () => {
    await recorder.start("running");

    expect(imuService.ensureRecording).toHaveBeenCalled();
  });

  it("does not block recording start when ensureRecording fails", async () => {
    (imuService.ensureRecording as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("IMU error"),
    );

    await recorder.start("running");

    expect(recorder.getSnapshot().state).toBe("recording");
  });

  it("calls syncForTimeRange on save with activity timestamps", async () => {
    await recorder.start("running");
    location.emitSample(makeSample());
    recorder.stop();

    await recorder.save("Morning run", null);

    expect(imuService.syncForTimeRange).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("saves activity successfully even when IMU sync fails", async () => {
    (imuService.syncForTimeRange as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Sync failed"),
    );

    await recorder.start("cycling");
    location.emitSample(makeSample());
    recorder.stop();

    const activityId = await recorder.save(null, null);

    expect(activityId).toBe("activity-123");
    expect(recorder.getSnapshot().state).toBe("idle");
  });

  it("works without IMU service (backwards compatible)", async () => {
    const recorderWithoutImu = createActivityRecorder(location, trpcClient, "Dofek iOS");

    await recorderWithoutImu.start("running");
    location.emitSample(makeSample());
    recorderWithoutImu.stop();

    const activityId = await recorderWithoutImu.save(null, null);
    expect(activityId).toBe("activity-123");
  });
});
