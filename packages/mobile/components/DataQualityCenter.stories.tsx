import type { DataQualityCheck, DataQualityOverview } from "@dofek/format/data-quality";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { colors } from "../theme";
import { DataQualityCenter } from "./DataQualityCenter";

const overview: DataQualityOverview = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  window: { days: 30, endDate: "2026-07-22" },
  overallStatus: "attention",
  overallMessage: "2 data quality checks need review.",
  checks: [
    {
      key: "coverage",
      label: "Missing days",
      status: "attention",
      title: "Coverage gaps",
      message: "Nutrition data is missing for 5 of the last 30 days.",
      count: 5,
      lastObservedDate: null,
      details: ["25 of 30 days contain nutrition data."],
    },
    {
      key: "source_overlap",
      label: "Source overlap",
      status: "attention",
      title: "Some records have overlapping sources",
      message: "Review the source decisions before interpreting these records.",
      count: 2,
      lastObservedDate: "2026-07-21",
      details: ["Nutrition: 2 overlapping days (1 unresolved)."],
    },
  ],
};

const meta = {
  title: "Data Quality/DataQualityCenter",
  component: DataQualityCenter,
  args: { data: overview },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <View style={{ backgroundColor: colors.background, padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof DataQualityCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Attention: Story = {};
export const Healthy: Story = {
  args: {
    data: {
      ...overview,
      overallStatus: "healthy",
      overallMessage: "Your recent data is ready to interpret.",
      checks: overview.checks.map((qualityCheck) => healthyCheck(qualityCheck)),
    },
  },
};
export const Informational: Story = {
  args: {
    data: {
      ...overview,
      overallStatus: "healthy",
      overallMessage: "Your recent data is ready to interpret.",
      checks: overview.checks.map((qualityCheck) => informationalCheck(qualityCheck)),
    },
  },
};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: undefined, loading: false } };

function healthyCheck(qualityCheck: DataQualityCheck): DataQualityCheck {
  return {
    ...qualityCheck,
    status: "healthy",
    title: "This check is clear",
    message: "No action is needed for this data-quality signal.",
    count: 0,
    lastObservedDate: null,
    details: [],
  };
}

function informationalCheck(qualityCheck: DataQualityCheck): DataQualityCheck {
  return {
    ...qualityCheck,
    status: "informational",
    title: "This is informational context",
    message: "Keep this context in mind when interpreting your health data.",
    count: 0,
    lastObservedDate: null,
    details: [],
  };
}
