import type { Meta, StoryObj } from "@storybook/react-native";
import { EmptyStatePreview } from "./EmptyStatePreview";

const meta = {
  title: "State/EmptyStatePreview",
  component: EmptyStatePreview,
  args: {
    content: {
      title: "Nothing needs your attention",
      message: "New sync, connection, and import problems will appear here.",
      previewTitle: "When an alert appears, it will show",
      previewItems: ["What happened", "When it happened", "What to do next"],
      note: "Only real problems detected for your account are shown.",
    },
  },
} satisfies Meta<typeof EmptyStatePreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AlertsAllClear: Story = {
  tags: ["review-scenario", "review-scenario-empty-data"],
};
