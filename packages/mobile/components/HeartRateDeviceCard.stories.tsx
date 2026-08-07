import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { HeartRateDeviceCard } from "./HeartRateDeviceCard";

const meta = {
  title: "Recording/HeartRateDeviceCard",
  component: HeartRateDeviceCard,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
  args: {
    bluetoothAvailable: true,
    connectionState: "disconnected",
    onConnect: () => {},
    onDisconnect: () => {},
  },
} satisfies Meta<typeof HeartRateDeviceCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const Connecting: Story = {
  args: { connectionState: "connecting" },
};

export const ConnectedWithReading: Story = {
  args: { connectionState: "connected", deviceName: "Polar H10", liveBpm: 142 },
};

export const ConnectedAwaitingFirstReading: Story = {
  args: { connectionState: "connected", deviceName: "Wahoo TICKR", liveBpm: null },
};

export const BluetoothOff: Story = {
  args: { bluetoothAvailable: false },
};
