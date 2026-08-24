import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { BluetoothDeviceList } from "./BluetoothDeviceList";

const devices = [
  {
    id: "whoop",
    kind: "whoop" as const,
    name: "WHOOP",
    peripheralId: null,
    connectionState: "ready",
    diagnostics: { imuBufferedSamples: 12, realtimeBufferedSamples: 4 },
  },
  {
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
  },
];

const meta = {
  title: "Settings/BluetoothDeviceList",
  component: BluetoothDeviceList,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
  args: {
    connecting: false,
    devices,
    error: null,
    loading: false,
    onConnectDevice: () => undefined,
    onSelectDevice: () => undefined,
  },
} satisfies Meta<typeof BluetoothDeviceList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

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
