import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock expo-location before importing
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
  requestBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
  watchPositionAsync: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  Accuracy: {
    BestForNavigation: 6,
  },
}));

import * as Location from "expo-location";
import { createLocationAdapter } from "./location-service.ts";

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
    } as never);

    const adapter = createLocationAdapter();
    const granted = await adapter.requestPermissions();

    expect(granted).toBe(false);
  });

  it("starts watching position with high accuracy", async () => {
    const adapter = createLocationAdapter();
    const callback = vi.fn();
    await adapter.startUpdates(callback);

    expect(Location.watchPositionAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
      }),
      expect.any(Function),
    );
  });

  it("transforms location events into GpsSample format", async () => {
    const adapter = createLocationAdapter();
    const callback = vi.fn();

    // Capture the location callback passed to watchPositionAsync
    let locationCallback: ((location: unknown) => void) | undefined;
    vi.mocked(Location.watchPositionAsync).mockImplementation(async (_opts, cb) => {
      locationCallback = cb;
      return { remove: vi.fn() };
    });

    await adapter.startUpdates(callback);

    // Simulate a location event
    locationCallback?.({
      timestamp: 1718438400000,
      coords: {
        latitude: 40.7128,
        longitude: -74.006,
        accuracy: 5,
        altitude: 10,
        speed: 3.5,
      },
    });

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

    let locationCallback: ((location: unknown) => void) | undefined;
    vi.mocked(Location.watchPositionAsync).mockImplementation(async (_opts, cb) => {
      locationCallback = cb;
      return { remove: vi.fn() };
    });

    await adapter.startUpdates(callback);

    locationCallback?.({
      timestamp: 1718438400000,
      coords: {
        latitude: 40.7128,
        longitude: -74.006,
        accuracy: 5,
        altitude: null,
        speed: -1, // Negative speed from GPS means no speed data
      },
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ speed: null }),
    );
  });

  it("stops watching position", async () => {
    const removeFn = vi.fn();
    vi.mocked(Location.watchPositionAsync).mockResolvedValue({
      remove: removeFn,
    });

    const adapter = createLocationAdapter();
    await adapter.startUpdates(vi.fn());
    await adapter.stopUpdates();

    expect(removeFn).toHaveBeenCalled();
  });

  it("handles stopUpdates when no subscription exists", async () => {
    const adapter = createLocationAdapter();
    // Should not throw
    await adapter.stopUpdates();
  });
});
