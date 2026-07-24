// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../modules/ble-probe", () => ({
  addNotificationListener: () => ({ remove: vi.fn() }),
  connect: vi.fn(),
  disconnect: vi.fn(),
  discoverCharacteristics: vi.fn(),
  discoverServices: vi.fn(),
  getConnectedPeripherals: vi.fn(() => []),
  isConnected: vi.fn(() => false),
  scan: vi.fn(),
  subscribe: vi.fn(),
  writeRaw: vi.fn(),
}));

describe("BleProbeScreen", () => {
  it("distinguishes the general and IMU status actions", async () => {
    const { default: BleProbeScreen } = await import("./ble-probe");
    render(<BleProbeScreen />);

    expect(screen.getByRole("button", { name: "BLE status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "IMU status" })).toBeTruthy();
  });
});
