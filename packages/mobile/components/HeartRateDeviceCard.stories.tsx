import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { HeartRateDeviceCard } from "./HeartRateDeviceCard";

const meta = {
  title: "Recording/HeartRateDeviceCard",
  component: HeartRateDeviceCard,
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
  args: {
    connectedDeviceCount: 0,
    error: null,
    onManageDevices: () => {},
  },
} satisfies Meta<typeof HeartRateDeviceCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NoConnectedDevices: Story = {};

export const OneConnectedDevice: Story = {
  args: { connectedDeviceCount: 1 },
};

export const MultipleConnectedDevices: Story = {
  args: { connectedDeviceCount: 2 },
};

export const CatalogError: Story = {
  args: { error: "Bluetooth permission is required to list devices." },
};
