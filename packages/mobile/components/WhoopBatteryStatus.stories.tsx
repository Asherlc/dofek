import type { Meta, StoryObj } from "@storybook/react-native";
import { WhoopBatteryStatus } from "./WhoopBatteryStatus";

const meta = {
  title: "Settings/WhoopBatteryStatus",
  component: WhoopBatteryStatus,
  args: { percentage: 57, isCharging: true },
} satisfies Meta<typeof WhoopBatteryStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Charging: Story = {};

export const Unknown: Story = {
  args: { percentage: null, isCharging: null },
};
