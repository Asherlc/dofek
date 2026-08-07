import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the background task executor registered via TaskManager.defineTask
// at module load so tests can simulate background location batches.
interface BackgroundTaskBody {
  data: { locations: unknown[] } | null;
  error: { message: string } | null;
}
const hoisted = vi.hoisted(() => {
  const holder: { taskExecutor?: (body: BackgroundTaskBody) => void } = {};
  return holder;
});

vi.mock("expo-task-manager", () => ({
  defineTask: vi.fn((_taskName: string, executor) => {
    hoisted.taskExecutor = executor;
  }),
}));

vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
  requestBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
  startLocationUpdatesAsync: vi.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: vi.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: vi.fn().mockResolvedValue(true),
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { Fitness: 3 },
}));

import * as Location from "expo-location";
import { BACKGROUND_LOCATION_TASK, createLocationAdapter } from "./location-service.ts";

function makeLocation(overrides?: { altitude?: number | null; speed?: number | null }) {
  return {
    timestamp: 1718438400000,
    coords: {
      latitude: 40.7128,
      longitude: -74.006,
      accuracy: 5,
      altitude: overrides?.altitude ?? 10,
      speed: overrides?.speed ?? 3.5,
    },
  };
}

describe("createLocationAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests foreground and background permissions", async () => {
    const adapter = createLocationAdapter();
    const granted = await adapter.requestPermissions();

    expect(granted).toBe(true);
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalled();
    expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalled();
  });

  it("returns false when foreground permissions denied", async () => {
    vi.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({
      status: "denied",
      granted: false,
      canAskAgain: true,
      expires: "never",
    });

    const adapter = createLocationAdapter();
    const granted = await adapter.requestPermissions();

    expect(granted).toBe(false);
    // Without foreground permission there is no point requesting background.
    expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("starts background-capable location updates with high accuracy", async () => {
    const adapter = createLocationAdapter();
    await adapter.startUpdates(vi.fn());

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      expect.objectContaining({
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        activityType: Location.ActivityType.Fitness,
        showsBackgroundLocationIndicator: true,
        pausesUpdatesAutomatically: false,
      }),
    );
  });

  it("forwards background task locations to the active callback as GpsSample", async () => {
    const adapter = createLocationAdapter();
    const callback = vi.fn();
    await adapter.startUpdates(callback);

    hoisted.taskExecutor?.({ data: { locations: [makeLocation()] }, error: null });

    expect(callback).toHaveBeenCalledWith({
      recordedAt: expect.stringContaining("2024-06-15"),
      lat: 40.7128,
      lng: -74.006,
      gpsAccuracy: 5,
      altitude: 10,
      speed: 3.5,
    });
  });

  it("treats negative speed as null", async () => {
    const adapter = createLocationAdapter();
    const callback = vi.fn();
    await adapter.startUpdates(callback);

    hoisted.taskExecutor?.({
      data: { locations: [makeLocation({ altitude: null, speed: -1 })] },
      error: null,
    });

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ speed: null }));
  });

  it("does not forward samples when the task reports an error", async () => {
    const adapter = createLocationAdapter();
    const callback = vi.fn();
    await adapter.startUpdates(callback);

    hoisted.taskExecutor?.({ data: null, error: { message: "location failed" } });

    expect(callback).not.toHaveBeenCalled();
  });

  it("stops location updates when they are running", async () => {
    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);

    const adapter = createLocationAdapter();
    await adapter.startUpdates(vi.fn());
    await adapter.stopUpdates();

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK);
  });

  it("does not stop location updates when none are running", async () => {
    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(false);

    const adapter = createLocationAdapter();
    await adapter.stopUpdates();

    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it("ignores background samples after updates are stopped", async () => {
    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);

    const adapter = createLocationAdapter();
    const callback = vi.fn();
    await adapter.startUpdates(callback);
    await adapter.stopUpdates();

    hoisted.taskExecutor?.({ data: { locations: [makeLocation()] }, error: null });

    expect(callback).not.toHaveBeenCalled();
  });
});
