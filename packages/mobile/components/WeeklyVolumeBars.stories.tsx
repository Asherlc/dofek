import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import { WeeklyVolumeBars } from "./WeeklyVolumeBars";

const meta = {
  title: "Training/WeeklyVolumeBars",
  component: WeeklyVolumeBars,
  args: {
    unit: "attempts",
    weeks: [
      { week: "2026-10-05", value: 12 },
      { week: "2026-10-12", value: 18 },
      { week: "2026-10-19", value: 9 },
    ],
  },
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 560 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof WeeklyVolumeBars>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { weeks: [] } };

export const MissingAndZero: Story = {
  args: {
    weeks: [
      { week: "2026-10-05", value: 12 },
      { week: "2026-10-12", value: 0 },
      { week: "2026-10-19", value: null },
    ],
  },
};

export const HoursMinutes: Story = {
  args: {
    unit: "h:mm",
    weeks: [
      { week: "2026-09-21", value: 600 },
      { week: "2026-09-28", value: 85.86666666666666 },
      { week: "2026-10-05", value: 45 },
      { week: "2026-10-12", value: 0 },
      { week: "2026-10-19", value: null },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("2026-09-21: 10:00 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-09-28: 1:26 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-05: 0:45 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-12: 0:00 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-19: Not recorded")).toBeVisible();
  },
};
