import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import type { BluetoothDevice } from "../lib/bluetooth-device-catalog";
import { spacing } from "../theme";
import { BluetoothDeviceList } from "./BluetoothDeviceList";

const whoop = {
  id: "whoop",
  kind: "whoop",
  name: "WHOOP",
  peripheralId: null,
  connectionState: "ready",
  diagnostics: { imuBufferedSamples: 12, realtimeBufferedSamples: 4 },
} satisfies BluetoothDevice;

const polar = {
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
} satisfies BluetoothDevice;

const meta = {
  title: "Settings/BluetoothDeviceList",
  component: BluetoothDeviceList,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <View style={{ alignSelf: "center", width: "100%", maxWidth: 390, padding: spacing.md }}>
        {Story()}
      </View>
    ),
  ],
  args: {
    connecting: false,
    devices: [whoop, polar],
    error: null,
    loading: false,
    onConnectDevice: () => undefined,
    onSelectDevice: () => undefined,
  },
} satisfies Meta<typeof BluetoothDeviceList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

function batteryDevices(
  percentage: number | null,
  isCharging: boolean | null,
  connectionState = "ready",
): BluetoothDevice[] {
  return [
    {
      ...whoop,
      name: "WHOOP MG",
      connectionState,
      diagnostics: { imuBufferedSamples: 12_480, realtimeBufferedSamples: 126 },
      battery: { percentage, isCharging },
    },
    { ...polar, connectionState: "ready" },
  ];
}

export const BatteryBadge: Story = {
  args: { devices: batteryDevices(57, true) },
};

export const BatteryNotCharging: Story = {
  args: { devices: batteryDevices(57, false) },
};

export const BatteryLow: Story = {
  args: { devices: batteryDevices(12, false) },
};

export const BatteryEmpty: Story = {
  args: { devices: batteryDevices(0, false) },
};

export const BatteryUnknown: Story = {
  args: { devices: batteryDevices(null, null) },
};

export const BatteryDisconnected: Story = {
  args: { devices: batteryDevices(57, true, "disconnected") },
};

export const UnsupportedWhoop: Story = {
  args: {
    devices: [
      {
        ...whoop,
        name: "WHOOP MG",
        connectionState: "idle",
        unsupportedDevice: true,
        diagnostics: { imuBufferedSamples: 0, realtimeBufferedSamples: 0 },
      },
      polar,
    ],
  },
};

export const Loading: Story = {
  args: { devices: [], loading: true },
};

export const Connecting: Story = {
  args: { connecting: true },
};

export const Empty: Story = {
  args: { devices: [] },
};

export const InitialError: Story = {
  args: { devices: [], error: "Bluetooth device registry is unavailable" },
};

export const RefreshError: Story = {
  args: { error: "Bluetooth devices could not be refreshed" },
};
