import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { RunningFormStats } from "./RunningFormStats";

const meta = {
  title: "Pages/ActivityDetail/RunningFormStats",
  component: RunningFormStats,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: "100%", maxWidth: 390 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof RunningFormStats>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  args: {
    form: {
      cadence: 178,
      cadenceBasis: "cadence_samples",
      cadenceObservedSeconds: 600,
      cadenceCoveragePercent: null,
      strideLengthMeters: 1.24,
      stanceTimeMs: 240,
      verticalOscillationMm: 8,
    },
  },
};

export const FormOnly: Story = {
  args: {
    form: {
      cadence: null,
      cadenceBasis: "unknown",
      cadenceObservedSeconds: null,
      cadenceCoveragePercent: null,
      strideLengthMeters: 2.1,
      stanceTimeMs: 210,
      verticalOscillationMm: 9,
    },
  },
};
