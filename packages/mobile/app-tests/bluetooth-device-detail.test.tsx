// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BluetoothDevice } from "../lib/bluetooth-device-catalog";

const mocks = vi.hoisted(() => ({
  back: vi.fn(),
  captureException: vi.fn(),
  getBluetoothDevices: vi.fn(),
  heartRateConnect: vi.fn(),
  heartRateDisconnect: vi.fn(),
  heartRateForget: vi.fn(),
  params: { id: "polar" },
  remove: vi.fn(),
  subscribeBluetoothDevices: vi.fn(),
  whoopConnect: vi.fn(),
  whoopDisconnect: vi.fn(),
  whoopFind: vi.fn(),
  whoopStartImuStreaming: vi.fn(),
  whoopStopImuStreaming: vi.fn(),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ back: mocks.back }),
}));

vi.mock("../lib/bluetooth-device-catalog", () => ({
  getBluetoothDevices: mocks.getBluetoothDevices,
  subscribeBluetoothDevices: mocks.subscribeBluetoothDevices,
}));

vi.mock("../modules/ble-heart-rate", () => ({
  connect: mocks.heartRateConnect,
  disconnect: mocks.heartRateDisconnect,
  forget: mocks.heartRateForget,
}));

vi.mock("../modules/whoop-ble", () => ({
  connect: mocks.whoopConnect,
  disconnect: mocks.whoopDisconnect,
  findWhoop: mocks.whoopFind,
  startImuStreaming: mocks.whoopStartImuStreaming,
  stopImuStreaming: mocks.whoopStopImuStreaming,
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mocks.captureException,
}));

const polar = {
  id: "polar",
  kind: "heart-rate" as const,
  name: "Polar H10",
  connectionState: "disconnected",
  diagnostics: {
    bufferedSampleCount: 3,
    lastHeartRateBpm: 142,
    lastMeasurementAt: "2026-08-24T19:00:00.000Z",
    lastRrIntervalsMs: [820],
  },
} satisfies BluetoothDevice;

const whoop = {
  id: "whoop",
  kind: "whoop" as const,
  name: "WHOOP",
  connectionState: "ready",
  peripheralId: null,
  diagnostics: { imuBufferedSamples: 12, realtimeBufferedSamples: 4 },
} satisfies BluetoothDevice;

describe("BluetoothDeviceDetailScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params.id = "polar";
    mocks.getBluetoothDevices.mockResolvedValue([polar]);
    mocks.subscribeBluetoothDevices.mockReturnValue({ remove: mocks.remove });
    mocks.heartRateConnect.mockResolvedValue({ id: "polar", name: "Polar H10" });
    mocks.whoopFind.mockResolvedValue({ id: "whoop-native", name: "WHOOP" });
    mocks.whoopConnect.mockResolvedValue(true);
    mocks.whoopStartImuStreaming.mockResolvedValue(true);
    mocks.whoopStopImuStreaming.mockResolvedValue(true);
  });

  it("shows a device's incoming native data and specific connection error", async () => {
    const connectionError = new Error("Heart-rate monitor not found: polar");
    mocks.heartRateConnect.mockRejectedValueOnce(connectionError);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    expect(await screen.findByText("142 bpm")).toBeTruthy();
    expect(screen.getByText("R-R intervals: 820 ms")).toBeTruthy();
    expect(screen.getByText("Buffered samples: 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Polar H10" }));

    expect(await screen.findByText(connectionError.message)).toBeTruthy();
    expect(mocks.captureException).toHaveBeenCalledWith(connectionError, {
      source: "bluetooth-device-detail-connect",
      deviceKind: "heart-rate",
    });
  });

  it("routes heart-rate disconnect to the selected device", async () => {
    mocks.getBluetoothDevices.mockResolvedValue([{ ...polar, connectionState: "ready" }]);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);
    await screen.findByText("Polar H10");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Polar H10" }));

    await waitFor(() => expect(mocks.heartRateDisconnect).toHaveBeenCalledWith("polar"));
  });

  it("forgets only the selected heart-rate device and returns to the list", async () => {
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);
    await screen.findByText("Polar H10");

    fireEvent.click(screen.getByRole("button", { name: "Forget Polar H10" }));

    await waitFor(() => expect(mocks.heartRateForget).toHaveBeenCalledWith("polar"));
    expect(mocks.back).toHaveBeenCalledOnce();
  });

  it("routes WHOOP actions to the existing WHOOP bridge and renders its native counters", async () => {
    mocks.params.id = "whoop";
    mocks.getBluetoothDevices.mockResolvedValue([whoop]);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    expect(
      await screen.findByText("Inertial measurement unit (IMU) buffered samples: 12"),
    ).toBeTruthy();
    expect(screen.getByText("Realtime buffered samples: 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect WHOOP" }));

    await waitFor(() => expect(mocks.whoopDisconnect).toHaveBeenCalledOnce());
  });

  it("starts WHOOP IMU streaming and renders the updated streaming status", async () => {
    let publish:
      | ((update: { state: "ready"; devices: (typeof whoop)[]; error: null }) => void)
      | undefined;
    mocks.params.id = "whoop";
    mocks.getBluetoothDevices.mockResolvedValue([whoop]);
    mocks.subscribeBluetoothDevices.mockImplementation((listener) => {
      publish = listener;
      return { remove: mocks.remove };
    });
    mocks.whoopStartImuStreaming.mockImplementation(async () => {
      mocks.getBluetoothDevices.mockResolvedValue([{ ...whoop, connectionState: "streaming" }]);
      publish?.({
        state: "ready",
        devices: [{ ...whoop, connectionState: "streaming" }],
        error: null,
      });
      return true;
    });
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start WHOOP inertial measurement unit (IMU) streaming",
      }),
    );

    await waitFor(() => expect(mocks.whoopStartImuStreaming).toHaveBeenCalledOnce());
    expect(screen.getByText("streaming")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Stop WHOOP inertial measurement unit (IMU) streaming",
      }),
    ).toBeTruthy();
  });

  it("stops WHOOP IMU streaming and shows the specific native error", async () => {
    const streamingWhoop = { ...whoop, connectionState: "streaming" };
    const streamingError = new Error("Could not stop WHOOP IMU streaming");
    mocks.params.id = "whoop";
    mocks.getBluetoothDevices.mockResolvedValue([streamingWhoop]);
    mocks.whoopStopImuStreaming.mockRejectedValueOnce(streamingError);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Stop WHOOP inertial measurement unit (IMU) streaming",
      }),
    );

    expect(await screen.findByText(streamingError.message)).toBeTruthy();
    expect(mocks.captureException).toHaveBeenCalledWith(streamingError, {
      source: "bluetooth-device-detail-stop-streaming",
      deviceKind: "whoop",
    });
  });

  it("finds and connects the native WHOOP peripheral from a disconnected snapshot", async () => {
    mocks.params.id = "whoop";
    mocks.getBluetoothDevices.mockResolvedValue([{ ...whoop, connectionState: "disconnected" }]);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect WHOOP" }));

    await waitFor(() => expect(mocks.whoopConnect).toHaveBeenCalledWith("whoop-native"));
  });

  it("keeps the WHOOP detail rendered across connect and disconnect catalog refreshes", async () => {
    let publish:
      | ((update: { state: "ready"; devices: (typeof whoop)[]; error: null }) => void)
      | undefined;
    mocks.params.id = "whoop";
    mocks.getBluetoothDevices.mockResolvedValue([{ ...whoop, connectionState: "disconnected" }]);
    mocks.subscribeBluetoothDevices.mockImplementation((listener) => {
      publish = listener;
      return { remove: mocks.remove };
    });
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);
    expect(await screen.findByRole("button", { name: "Connect WHOOP" })).toBeTruthy();

    act(() =>
      publish?.({
        state: "ready",
        devices: [{ ...whoop, connectionState: "connected", peripheralId: "whoop-native" }],
        error: null,
      }),
    );
    expect(screen.getByRole("button", { name: "Disconnect WHOOP" })).toBeTruthy();
    expect(screen.queryByText("Bluetooth device not found.")).toBeNull();

    act(() =>
      publish?.({
        state: "ready",
        devices: [{ ...whoop, connectionState: "disconnected", peripheralId: null }],
        error: null,
      }),
    );
    expect(screen.getByRole("button", { name: "Connect WHOOP" })).toBeTruthy();
    expect(screen.queryByText("Bluetooth device not found.")).toBeNull();
  });

  it("connects WHOOP with the retained native peripheral ID without scanning again", async () => {
    mocks.params.id = "whoop";
    mocks.getBluetoothDevices.mockResolvedValue([
      { ...whoop, connectionState: "disconnected", peripheralId: "whoop-retained" },
    ]);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect WHOOP" }));

    await waitFor(() => expect(mocks.whoopConnect).toHaveBeenCalledWith("whoop-retained"));
    expect(mocks.whoopFind).not.toHaveBeenCalled();
  });

  it("shows the specific initial catalog failure rather than a missing-device state", async () => {
    const catalogError = new Error("Bluetooth registry unavailable");
    mocks.getBluetoothDevices.mockRejectedValueOnce(catalogError);
    const { default: BluetoothDeviceDetailScreen } = await import("../app/bluetooth-devices/[id]");
    render(<BluetoothDeviceDetailScreen />);

    expect(await screen.findByText(catalogError.message)).toBeTruthy();
    expect(screen.queryByText("Bluetooth device not found.")).toBeNull();
    expect(mocks.captureException).toHaveBeenCalledWith(catalogError, {
      source: "bluetooth-device-detail-load",
    });
  });
});
