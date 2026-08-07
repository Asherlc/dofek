import type { Meta, StoryObj } from "@storybook/react-native";
import { EmptyStatePreview } from "./EmptyStatePreview";

const meta = {
  title: "State/EmptyStatePreview",
  component: EmptyStatePreview,
  args: {
    content: {
      title: "Your monthly report will appear here",
      message: "No activity, sleep, or recovery data is available for this report yet.",
      requirement:
        "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
      previewTitle: "When ready, your monthly report will include",
      previewItems: [
        "Training time and activity count",
        "Average daily strain",
        "Average sleep duration",
        "Average resting heart rate",
        "Average heart rate variability",
        "Month-over-month training and sleep changes",
      ],
      note: "This preview shows report sections only. No personal values or conclusions are estimated.",
    },
  },
} satisfies Meta<typeof EmptyStatePreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MonthlyReport: Story = {
  tags: ["review-scenario", "review-scenario-empty-data"],
};

export const AlertsAllClear: Story = {
  args: {
    content: {
      title: "Nothing needs your attention",
      message: "New sync, connection, and import problems will appear here.",
      previewTitle: "When an alert appears, it will show",
      previewItems: ["What happened", "When it happened", "What to do next"],
      note: "Only real problems detected for your account are shown.",
    },
  },
};
