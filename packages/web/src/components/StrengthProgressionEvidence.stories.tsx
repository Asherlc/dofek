import type { Meta, StoryObj } from "@storybook/react-vite";
import { StrengthProgressionEvidence } from "./StrengthProgressionEvidence.tsx";
import { flatBenchmarkRow, repImprovementRow } from "./training-progression-fixture.ts";

const meta = {
  title: "Training/StrengthProgressionEvidence",
  component: StrengthProgressionEvidence,
  args: { row: repImprovementRow },
} satisfies Meta<typeof StrengthProgressionEvidence>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RecordedSets: Story = {};
export const FlatBenchmark: Story = { args: { row: flatBenchmarkRow } };
