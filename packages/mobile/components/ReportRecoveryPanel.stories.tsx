import type { Meta, StoryObj } from "@storybook/react-native";
import { ReportRecoveryPanel } from "./ReportRecoveryPanel";

const meta = {
  title: "Reports/ReportRecoveryPanel",
  component: ReportRecoveryPanel,
  args: {
    message:
      "The weekly report for 2026-05-03 through 2026-07-24 could not be refreshed. Retry now or review processing alerts if the problem continues.",
    onRetry: () => {},
    onReviewData: () => {},
  },
} satisfies Meta<typeof ReportRecoveryPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BlockingError: Story = {
  tags: ["review-scenario", "review-scenario-error"],
};

export const PreservedReport: Story = {
  args: { preserved: true },
};

export const Retrying: Story = {
  args: { retrying: true },
};
