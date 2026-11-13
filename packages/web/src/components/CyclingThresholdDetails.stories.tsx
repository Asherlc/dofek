import type { Meta, StoryObj } from "@storybook/react-vite";
import { CyclingThresholdDetails } from "./CyclingThresholdDetails";

const meta = {
  title: "Components/CyclingThresholdDetails",
  component: CyclingThresholdDetails,
  args: {
    evidence: {
      value: 250,
      unit: "watt",
      method: "computed_eftp",
      event_at: "2026-03-05T12:00:00Z",
      evidence_activity_id: "00000000-0000-4000-8000-000000000101",
      evidence_at: "2026-03-01T12:00:00Z",
      evidence_duration_seconds: 1200,
      evidence_power: 265,
      model_version: "v1",
      uncertainty: {
        kind: "not_quantifiable" as const,
        watts: null,
        reason:
          "Reference-curve estimate; individual physiological FTP uncertainty has not been quantified.",
      },
      unavailable_reason: null,
    },
  },
} satisfies Meta<typeof CyclingThresholdDetails>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Supported: Story = {};
export const InsufficientEvidence: Story = {
  args: {
    evidence: {
      ...meta.args.evidence,
      value: null,
      unavailable_reason: "No supported sustained cycling power effort is available.",
    },
  },
};
