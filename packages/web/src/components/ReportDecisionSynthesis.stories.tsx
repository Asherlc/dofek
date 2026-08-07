import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReportDecisionSynthesis } from "./ReportDecisionSynthesis.tsx";

const synthesis = {
  whatChanged: [
    "Training was 6 hours, 50% more than the previous week.",
    "Average nightly sleep was 7 hours, 30 minutes less than the previous week.",
  ],
  likelyAssociations: [
    "Higher training coincided with less sleep and lower heart rate variability this week. This is a descriptive association, not evidence that one change caused another.",
  ],
  whatWorked: [
    "You completed 4 activities; no recovery improvement is clear in the available weekly metrics.",
  ],
  whatToTryNext: [
    "Keep training near 6 hours and protect the sleep schedule next week, then compare sleep and recovery again before increasing volume.",
  ],
  confidenceAndMissingData: [
    "Confidence is limited because only 2 weekly periods are available.",
    "These period averages can show co-movement, but they cannot establish cause and effect.",
  ],
};

const meta = {
  title: "Reports/ReportDecisionSynthesis",
  component: ReportDecisionSynthesis,
  args: { synthesis },
} satisfies Meta<typeof ReportDecisionSynthesis>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MissingData: Story = {
  args: {
    synthesis: {
      ...synthesis,
      confidenceAndMissingData: [
        ...synthesis.confidenceAndMissingData,
        "Missing current-period data: sleep and heart rate variability.",
      ],
    },
  },
};

export const Empty: Story = {
  args: {
    synthesis: {
      whatChanged: [],
      likelyAssociations: [],
      whatWorked: [],
      whatToTryNext: [],
      confidenceAndMissingData: [],
    },
  },
};
