import type { Meta, StoryObj } from "@storybook/react-vite";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard.tsx";

const meta = {
  title: "Processing/SourceProcessingStatusCard",
  component: SourceProcessingStatusCard,
  args: {
    contextLabel: "Garmin",
    heading: "Syncing Garmin",
    message: "Importing recent activities.",
    progress: 60,
    status: "active",
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] bg-page p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SourceProcessingStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
export const Waiting: Story = {
  args: { heading: "Waiting for analytics", message: null, progress: null, status: "waiting" },
};
export const Ready: Story = {
  args: {
    heading: "Garmin is ready",
    message: "All data is current.",
    progress: 100,
    status: "ready",
  },
};
export const Failed: Story = {
  args: {
    heading: "Garmin processing failed",
    message: "Reconnect Garmin, then retry the sync.",
    progress: null,
    status: "failed",
  },
};
