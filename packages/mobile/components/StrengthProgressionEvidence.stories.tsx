import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { StrengthProgressionEvidence } from "./StrengthProgressionEvidence";
import { flatBenchmarkRow, repImprovementRow } from "./training-progression-fixture";

const meta = {
  title: "Training/StrengthProgressionEvidence",
  component: StrengthProgressionEvidence,
  args: { row: repImprovementRow, units: new UnitConverter("metric") },
} satisfies Meta<typeof StrengthProgressionEvidence>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RecordedSets: Story = {};
export const FlatBenchmark: Story = { args: { row: flatBenchmarkRow } };
