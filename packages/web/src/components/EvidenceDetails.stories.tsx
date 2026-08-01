import type { Meta, StoryObj } from "@storybook/react-vite";
import { EvidenceDetails } from "./EvidenceDetails";

const meta = {
  title: "Evidence/EvidenceDetails",
  component: EvidenceDetails,
  tags: ["autodocs"],
  args: {
    details: [
      { key: "method", label: "Method", value: "Server-authored comparison method." },
      {
        key: "interpretation",
        label: "Interpretation",
        value: "This describes an observed association; it does not establish causation.",
      },
      { key: "uncertainty", label: "Uncertainty", value: "No interval is available." },
    ],
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-lg border border-border bg-surface p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EvidenceDetails>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  tags: ["review-scenario", "review-scenario-empty-data"],
  args: { details: [] },
};
