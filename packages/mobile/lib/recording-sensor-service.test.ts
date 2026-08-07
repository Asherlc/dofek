import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));

import {
  combineRecordingSensorServices,
  type RecordingSensorService,
} from "./recording-sensor-service.ts";
import { captureException } from "./telemetry";

function makeMockService(): RecordingSensorService {
  return {
    ensureRecording: vi.fn().mockResolvedValue(undefined),
    syncForTimeRange: vi.fn().mockResolvedValue(undefined),
  };
}

describe("combineRecordingSensorServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls ensureRecording on every service", async () => {
    const first = makeMockService();
    const second = makeMockService();

    await combineRecordingSensorServices([first, second]).ensureRecording();

    expect(first.ensureRecording).toHaveBeenCalledTimes(1);
    expect(second.ensureRecording).toHaveBeenCalledTimes(1);
  });

  it("calls syncForTimeRange on every service with the window", async () => {
    const first = makeMockService();
    const second = makeMockService();

    await combineRecordingSensorServices([first, second]).syncForTimeRange("start", "end");

    expect(first.syncForTimeRange).toHaveBeenCalledWith("start", "end");
    expect(second.syncForTimeRange).toHaveBeenCalledWith("start", "end");
  });

  it("isolates a failing service so others still run, and reports the failure", async () => {
    const failing = makeMockService();
    vi.mocked(failing.syncForTimeRange).mockRejectedValue(new Error("upload failed"));
    const healthy = makeMockService();

    await expect(
      combineRecordingSensorServices([failing, healthy]).syncForTimeRange("start", "end"),
    ).resolves.toBeUndefined();

    expect(healthy.syncForTimeRange).toHaveBeenCalledWith("start", "end");
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "recording-sensor-service.syncForTimeRange" }),
    );
  });

  it("reports ensureRecording failures without throwing", async () => {
    const failing = makeMockService();
    vi.mocked(failing.ensureRecording).mockRejectedValue(new Error("start failed"));

    await expect(
      combineRecordingSensorServices([failing]).ensureRecording(),
    ).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "recording-sensor-service.ensureRecording" }),
    );
  });

  it("no-ops cleanly with an empty service list", async () => {
    const combined = combineRecordingSensorServices([]);
    await expect(combined.ensureRecording()).resolves.toBeUndefined();
    await expect(combined.syncForTimeRange("start", "end")).resolves.toBeUndefined();
  });
});
