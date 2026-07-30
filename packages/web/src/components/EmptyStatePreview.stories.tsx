import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyStatePreview } from "./EmptyStatePreview.tsx";

const meta = {
  title: "State/EmptyStatePreview",
  component: EmptyStatePreview,
  tags: ["autodocs"],
  args: {
    content: {
      title: "Your weekly report will appear here",
      message: "No activity, sleep, or recovery data is available for this report yet.",
      requirement:
        "At least 1 observed day of activity, sleep, or recovery data is required to create a weekly report.",
      previewTitle: "When ready, your weekly report will include",
      previewItems: [
        "Training time and activity count",
        "Average nightly sleep",
        "Average resting heart rate",
        "Average heart rate variability",
        "Recent week comparisons",
      ],
      note: "This preview shows report sections only. No personal values or conclusions are estimated.",
    },
  },
} satisfies Meta<typeof EmptyStatePreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WeeklyReport: Story = {
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
