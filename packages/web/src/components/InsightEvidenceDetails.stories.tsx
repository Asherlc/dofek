import type { Meta, StoryObj } from "@storybook/react-vite";
import type { InsightEvidence } from "dofek-server/types";
import { InsightEvidenceDetails } from "./InsightEvidenceDetails";

const evidence: InsightEvidence = {
  relationship: "descriptive_association",
  label: "Descriptive association",
  method: "Observed-group mean comparison over paired observations.",
  estimateLabel: "15% lower",
};

const meta = {
  title: "Insights/InsightEvidenceDetails",
  component: InsightEvidenceDetails,
  tags: ["autodocs"],
  args: { evidence },
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-lg border border-border bg-surface p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InsightEvidenceDetails>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PartialEvidence: Story = {
  args: {
    evidence: {
      method: evidence.method,
    },
  },
};

export const EmptyEvidence: Story = {
  tags: ["review-scenario", "review-scenario-empty-data"],
  args: { evidence: {} },
};
