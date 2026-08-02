import type { DataQualityOverview } from "@dofek/format/data-quality";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataQualityCenter } from "./DataQualityCenter.tsx";

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
    {
      key: "sync_freshness",
      label: "Sync freshness",
      status: "healthy",
      title: "Data updates are current",
      message: "All selected datasets are ready.",
      count: 0,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "outliers",
      label: "Outliers",
      status: "healthy",
      title: "No unusual observations were flagged",
      message: "No unusual observations were flagged in the last 30 days.",
      count: 0,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "manual_edits",
      label: "Manual edits",
      status: "informational",
      title: "Manual entries are included",
      message: "1 manually entered journal record was recorded in the last 30 days.",
      count: 1,
      lastObservedDate: "2026-07-19",
      details: [],
    },
  ],
};

const meta = {
  title: "Data Quality/DataQualityCenter",
  component: DataQualityCenter,
  args: { data: overview },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DataQualityCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Attention: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: undefined, loading: false } };
