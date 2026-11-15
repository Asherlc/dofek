import type { Meta, StoryObj } from "@storybook/react-native";
import { CyclingThresholdDetails } from "./CyclingThresholdDetails";

const meta = {
  title: "Components/CyclingThresholdDetails",
  component: CyclingThresholdDetails,
  args: {
    evidence: {
      value: 250,
      unit: "watt",
      method: "configured",
      effective_from: "2026-03-01",
      source_record_id: "00000000-0000-4000-8000-000000000101",
      unavailable_reason: null,
    },
  },
} satisfies Meta<typeof CyclingThresholdDetails>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Configured: Story = {};
export const NoEffectiveDate: Story = {
  args: { evidence: { ...meta.args.evidence, effective_from: null } },
};
