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

describe("iOS health gateway", () => {
  it("identifies the HealthKit implementation without exposing a platform check to consumers", () => {
    expect(healthGateway.kind).toBe("health-kit");
  });
});
