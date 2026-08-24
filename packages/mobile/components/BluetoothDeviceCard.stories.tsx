import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { BluetoothDeviceCard } from "./BluetoothDeviceCard";

const meta = {
  title: "Recording/BluetoothDeviceCard",
  component: BluetoothDeviceCard,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
  args: {
    connectedDeviceCount: 0,
    error: null,
    loading: false,
    onManageDevices: () => {},
  },
} satisfies Meta<typeof BluetoothDeviceCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NoConnectedDevices: Story = {};

export const Loading: Story = {
  args: { loading: true },
};

export const OneConnectedDevice: Story = {
  args: { connectedDeviceCount: 1 },
};

export const MultipleConnectedDevices: Story = {
  args: { connectedDeviceCount: 2 },
};

export const CatalogError: Story = {
  args: { error: "Bluetooth permission is required to list devices." },
};
