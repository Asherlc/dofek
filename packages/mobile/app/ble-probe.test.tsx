// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCaptureException, writeRawMock } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  writeRawMock: vi.fn(),
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

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
  writeRaw: writeRawMock,
}));

describe("BleProbeScreen", () => {
  beforeEach(() => {
    writeRawMock.mockReset();
    writeRawMock.mockResolvedValue(undefined);
  });

  it("distinguishes the general and IMU status actions", async () => {
    const { default: BleProbeScreen } = await import("./ble-probe");
    render(<BleProbeScreen />);

    const bluetoothStatus = screen.getByRole("button", {
      name: "Bluetooth Low Energy (BLE) connection and data status",
    });
    const whoopStatus = screen.getByRole("button", { name: "WHOOP data status" });

    expect(bluetoothStatus.getAttribute("aria-label")).toBe(
      "Bluetooth Low Energy (BLE) connection and data status",
    );
    expect(whoopStatus.getAttribute("aria-label")).toBe("WHOOP data status");
  });

  it("prevents repeated Hello and IMU commands while the write is in progress", async () => {
    writeRawMock.mockImplementationOnce(() => new Promise(() => undefined));
    const { default: BleProbeScreen } = await import("./ble-probe");
    render(<BleProbeScreen />);

    const helloButton = screen.getByRole("button", {
      name: "Send hello and toggle inertial measurement unit (IMU) mode",
    });
    fireEvent.click(helloButton);

    await waitFor(() => {
      expect(helloButton.getAttribute("aria-busy")).toBe("true");
      expect(helloButton).toHaveProperty("disabled", true);
    });
    fireEvent.click(helloButton);
    expect(writeRawMock).toHaveBeenCalledTimes(1);
  });

  it("reports native command failures while keeping them in the on-screen log", async () => {
    const writeError = new Error("Native write failed");
    writeRawMock.mockRejectedValueOnce(writeError);
    const { default: BleProbeScreen } = await import("./ble-probe");
    render(<BleProbeScreen />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Send hello and toggle inertial measurement unit (IMU) mode",
      }),
    );

    await waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
        source: "ble-probe-hello-imu",
      });
    });
  });

  it("disables Send when the command is blank", async () => {
    const { default: BleProbeScreen } = await import("./ble-probe");
    render(<BleProbeScreen />);

    const sendButton = screen.getByRole("button", { name: "Send command" });
    expect(sendButton).toHaveProperty("disabled", true);
    expect(sendButton.getAttribute("aria-disabled")).toBe("true");
  });
});
