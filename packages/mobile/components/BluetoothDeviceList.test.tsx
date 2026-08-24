import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BluetoothDevice } from "../lib/bluetooth-device-catalog";
import { BluetoothDeviceList } from "./BluetoothDeviceList";

const whoop: BluetoothDevice = {
  id: "whoop",
  kind: "whoop",
  name: "WHOOP",
  peripheralId: null,
  connectionState: "ready",
  diagnostics: { imuBufferedSamples: 12, realtimeBufferedSamples: 4 },
};

const polar: BluetoothDevice = {
  id: "polar",
  kind: "heart-rate",
  name: "Polar H10",
  connectionState: "disconnected",
  diagnostics: {
    bufferedSampleCount: 3,
    lastHeartRateBpm: 142,
    lastMeasurementAt: "2026-08-24T19:00:00.000Z",
    lastRrIntervalsMs: [820],
  },
};

const baseProps = {
  devices: [whoop, polar],
  error: null,
  loading: false,
  connecting: false,
  onConnectDevice: () => undefined,
  onSelectDevice: () => undefined,
};

describe("BluetoothDeviceList", () => {
  it("renders every device as a separately named accessibility action", () => {
    render(<BluetoothDeviceList {...baseProps} />);

    expect(screen.getByRole("button", { name: "WHOOP, ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Polar H10, disconnected" })).toBeTruthy();
    expect(screen.getByText("12 IMU samples · 4 realtime samples")).toBeTruthy();
    expect(screen.getByText("142 bpm · 3 buffered samples")).toBeTruthy();
  });

  it("selects the exact device row that was pressed", () => {
    const onSelectDevice = vi.fn();
    render(<BluetoothDeviceList {...baseProps} onSelectDevice={onSelectDevice} />);

    fireEvent.click(screen.getByRole("button", { name: "Polar H10, disconnected" }));

    expect(onSelectDevice).toHaveBeenCalledWith(polar);
  });

  it("shows a blocking loading state before a snapshot exists", () => {
    render(<BluetoothDeviceList {...baseProps} devices={[]} loading />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Bluetooth device" })).toBeNull();
  });

  it("shows the specific blocking error instead of an empty state", () => {
    render(
      <BluetoothDeviceList
        {...baseProps}
        devices={[]}
        error="Bluetooth device registry is unavailable"
      />,
    );

    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(screen.getByText("Bluetooth device registry is unavailable")).toBeTruthy();
    expect(screen.queryByText("No Bluetooth devices found.")).toBeNull();
  });

  it("shows an empty state and still permits pairing", () => {
    const onConnectDevice = vi.fn();
    render(<BluetoothDeviceList {...baseProps} devices={[]} onConnectDevice={onConnectDevice} />);

    expect(screen.getByTestId("query-state-empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Bluetooth device" }));
    expect(onConnectDevice).toHaveBeenCalledOnce();
  });

  it("retains device rows and shows a refresh error together", () => {
    render(<BluetoothDeviceList {...baseProps} error="Bluetooth devices could not be refreshed" />);

    expect(screen.getByRole("button", { name: "WHOOP, ready" })).toBeTruthy();
    expect(screen.getByText("Bluetooth devices could not be refreshed")).toBeTruthy();
  });
});
