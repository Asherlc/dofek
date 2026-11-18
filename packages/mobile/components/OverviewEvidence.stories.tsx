import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { overviewEvidenceFixture } from "../app-fixtures/(tabs)/overview-evidence";
import { OverviewEvidence } from "./OverviewEvidence";

const meta = {
  title: "Overview/Evidence",
  component: OverviewEvidence,
  args: {
    ...overviewEvidenceFixture,
    endDate: "2026-11-17",
    units: new UnitConverter("metric"),
    openBody: fn(),
    openHeartRate: fn(),
    openCorrelation: fn(),
  },
} satisfies Meta<typeof OverviewEvidence>;

export default meta;
type Story = StoryObj<typeof OverviewEvidence>;
export const Default: Story = {};
export const Loading: Story = {
  args: {
    insights: { isLoading: true },
    heartRate: { isLoading: true },
    trends: { isLoading: true },
  },
};
export const Empty: Story = {
  args: {
    insights: { isLoading: false, data: [] },
    heartRate: { isLoading: false, data: [] },
    trends: { isLoading: false, data: null },
  },
};
