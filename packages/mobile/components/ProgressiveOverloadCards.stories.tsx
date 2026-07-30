import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import type { ProgressiveOverloadRow } from "dofek-server/types";
import { View } from "react-native";
import { ProgressiveOverloadCards } from "./ProgressiveOverloadCards";

const exercise: ProgressiveOverloadRow = {
  exerciseName: "Back Squat",
  observations: [
    { week: "2026-01-05", totalVolumeKg: 4_800 },
    { week: "2026-01-19", totalVolumeKg: 5_100 },
    { week: "2026-02-02", totalVolumeKg: 5_450 },
    { week: "2026-02-09", totalVolumeKg: 5_250 },
  ],
  period: {
    startWeek: "2026-01-05",
    endWeek: "2026-02-09",
    observationCount: 4,
    elapsedWeekCount: 6,
  },
  slopeKgPerWeek: 100,
  trend: "increasing",
  uncertainty: {
    availability: "available",
    level: 0.95,
    method: "residual_circular_moving_block_bootstrap",
    methodLabel: "95% moving-block interval",
    lowerKgPerWeek: -25,
    upperKgPerWeek: 240,
    statement: "The interval reflects variation and short-range dependence among recorded weeks.",
  },
  interpretation:
    "Recorded weekly volume increased over this period. An increase is not inherently good or bad.",
  deloadContext:
    "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.",
};

const meta = {
  title: "Strength/ProgressiveOverloadCards",
  component: ProgressiveOverloadCards,
  args: { exercises: [exercise], units: new UnitConverter("metric") },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: 390 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ProgressiveOverloadCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const UnavailableUncertainty: Story = {
  args: {
    exercises: [
      {
        ...exercise,
        uncertainty: {
          availability: "unavailable",
          level: 0.95,
          method: "residual_circular_moving_block_bootstrap",
          methodLabel: "95% moving-block interval",
          reason: "insufficient_observations",
          statement: "Uncertainty needs at least 4 recorded weeks; this estimate has 3.",
        },
      },
    ],
  },
};
export const Loading: Story = { args: { exercises: [], loading: true } };
export const Empty: Story = { args: { exercises: [] } };
