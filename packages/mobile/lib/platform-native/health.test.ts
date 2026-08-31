import { describe, expect, it, vi } from "vitest";

vi.mock("../../modules/health-kit", () => ({
  deleteDietarySamples: vi.fn(),
  getRequestStatus: vi.fn(),
  isAvailable: vi.fn(),
  purgeAccountState: vi.fn(),
  requestPermissions: vi.fn(),
  writeDietarySamples: vi.fn(),
}));

import { healthGateway } from "./health.ios";

vi.mock("../../modules/health-connect", () => ({
  deleteDietarySamples: vi.fn(),
  getRequestStatus: vi.fn(async () => "unnecessary"),
  isAvailable: vi.fn(() => true),
  purgeAccountState: vi.fn(),
  requestPermissions: vi.fn(async () => true),
  writeDietarySamples: vi.fn(),
}));

vi.mock("../telemetry", () => ({ captureException: vi.fn() }));

import { requestPermissions as requestHealthConnectPermissions } from "../../modules/health-connect";
import { captureException } from "../telemetry";
import { healthGateway as androidHealthGateway } from "./health.android";

describe("iOS health gateway", () => {
  it("identifies the HealthKit implementation without exposing a platform check to consumers", () => {
    expect(healthGateway.kind).toBe("health-kit");
  });
});

describe("Android health gateway", () => {
  it("identifies the Health Connect implementation and exposes the native permission state", async () => {
    expect(androidHealthGateway.kind).toBe("health-connect");
    await expect(androidHealthGateway.getRequestStatus()).resolves.toBe("unnecessary");
    expect(androidHealthGateway.isAvailable()).toBe(true);
  });

  it("reports a permission-request failure before surfacing its actionable native message", async () => {
    const error = new Error("Health Connect is unavailable. Install or update Health Connect.");
    vi.mocked(requestHealthConnectPermissions).mockRejectedValueOnce(error);

    await expect(androidHealthGateway.requestPermissions()).rejects.toThrow(error.message);
    expect(captureException).toHaveBeenCalledWith(error, {
      source: "health-connect-request-permissions",
    });
  });
});
