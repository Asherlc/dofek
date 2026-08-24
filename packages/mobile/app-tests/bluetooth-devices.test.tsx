// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let focusEffect: (() => void) | undefined;

  return {
    captureException: vi.fn(),
    focus() {
      focusEffect?.();
    },
    getBluetoothDevices: vi.fn(),
    push: vi.fn(),
    remove: vi.fn(),
    resetFocusEffect() {
      focusEffect = undefined;
    },
    scanAndConnect: vi.fn(),
    setFocusEffect(callback: () => void) {
      focusEffect = callback;
    },
    subscribeBluetoothDevices: vi.fn(),
  };
});

vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");

  return {
    useFocusEffect: (callback: () => void) => {
      useEffect(() => {
        mocks.setFocusEffect(callback);
        callback();
      }, [callback]);
    },
    useRouter: () => ({ push: mocks.push }),
  };
});

vi.mock("../lib/bluetooth-device-catalog", () => ({
  getBluetoothDevices: mocks.getBluetoothDevices,
  subscribeBluetoothDevices: mocks.subscribeBluetoothDevices,
}));

vi.mock("../modules/ble-heart-rate", () => ({
  scanAndConnect: mocks.scanAndConnect,
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mocks.captureException,
}));

const whoop = {
  id: "whoop",
  kind: "whoop" as const,
  name: "WHOOP",
  connectionState: "ready",
  peripheralId: null,
  diagnostics: { imuBufferedSamples: 12, realtimeBufferedSamples: 4 },
};

const polar = {
  id: "polar",
  kind: "heart-rate" as const,
  name: "Polar H10",
  connectionState: "disconnected",
  diagnostics: {
    bufferedSampleCount: 0,
    lastHeartRateBpm: null,
    lastMeasurementAt: null,
    lastRrIntervalsMs: [],
  },
};

const wahoo = {
  id: "wahoo",
  kind: "heart-rate" as const,
  name: "Wahoo TICKR",
  connectionState: "ready",
  diagnostics: {
    bufferedSampleCount: 1,
    lastHeartRateBpm: 61,
    lastMeasurementAt: "2026-08-24T19:00:00.000Z",
    lastRrIntervalsMs: [984],
  },
};

describe("BluetoothDevicesScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetFocusEffect();
    mocks.getBluetoothDevices.mockResolvedValue([whoop, polar, wahoo]);
    mocks.scanAndConnect.mockResolvedValue({ id: "new-monitor", name: "New monitor" });
    mocks.subscribeBluetoothDevices.mockReturnValue({ remove: mocks.remove });
  });

  it("renders WHOOP and each paired heart-rate monitor as separate accessible rows", async () => {
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    render(<BluetoothDevicesScreen />);

    expect(await screen.findByRole("button", { name: "WHOOP, ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Polar H10, disconnected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wahoo TICKR, ready" })).toBeTruthy();
  });

  it("opens the selected device's encoded detail route", async () => {
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    render(<BluetoothDevicesScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Polar H10, disconnected" }));

    expect(mocks.push).toHaveBeenCalledWith("/bluetooth-devices/polar");
  });

  it("starts pairing an additional monitor without removing listed devices", async () => {
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    render(<BluetoothDevicesScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect Bluetooth device" }));

    await waitFor(() => expect(mocks.scanAndConnect).toHaveBeenCalledOnce());
    expect(screen.getByText("Polar H10")).toBeTruthy();
  });

  it("keeps prior devices visible when a subscription refresh fails", async () => {
    let publish: ((update: { state: "error"; devices: []; error: string }) => void) | undefined;
    mocks.subscribeBluetoothDevices.mockImplementation((listener) => {
      publish = listener;
      return { remove: mocks.remove };
    });
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    render(<BluetoothDevicesScreen />);
    expect(await screen.findByText("Polar H10")).toBeTruthy();

    act(() => publish?.({ state: "error", devices: [], error: "Native refresh failed" }));

    expect(await screen.findByText("Native refresh failed")).toBeTruthy();
    expect(screen.getByText("Polar H10")).toBeTruthy();
  });

  it("reports and displays the specific pairing failure", async () => {
    const pairingError = new Error("No heart-rate monitor found");
    mocks.scanAndConnect.mockRejectedValueOnce(pairingError);
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    render(<BluetoothDevicesScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect Bluetooth device" }));

    expect(await screen.findByText(pairingError.message)).toBeTruthy();
    expect(mocks.captureException).toHaveBeenCalledWith(pairingError, {
      source: "bluetooth-devices-scan-and-connect",
    });
  });

  it("unsubscribes from catalog updates when the route unmounts", async () => {
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    const view = render(<BluetoothDevicesScreen />);
    await screen.findByText("WHOOP");

    view.unmount();

    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("removes a forgotten monitor when the list regains focus without remounting", async () => {
    const { default: BluetoothDevicesScreen } = await import("../app/bluetooth-devices/index");
    render(<BluetoothDevicesScreen />);
    expect(await screen.findByText("Polar H10")).toBeTruthy();
    mocks.getBluetoothDevices.mockResolvedValue([whoop, wahoo]);

    act(() => mocks.focus());

    await waitFor(() => expect(screen.queryByText("Polar H10")).toBeNull());
    expect(screen.getByText("WHOOP")).toBeTruthy();
  });
});
