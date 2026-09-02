import type { Meta, StoryObj } from "@storybook/react-native";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard";

const meta = {
  title: "State/SourceProcessingStatusCard",
  component: SourceProcessingStatusCard,
  args: {
    contextLabel: "Garmin",
    heading: "Importing activities",
    message: "Processing provider data.",
    progress: 60,
    status: "active",
  },
} satisfies Meta<typeof SourceProcessingStatusCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Active: Story = {};

export const Waiting: Story = {
  args: {
    heading: "Waiting to import",
    message: "The import is queued.",
    progress: null,
    status: "waiting",
  },
};

export const Delayed: Story = {
  args: {
    heading: "Import delayed",
    message: "Processing is taking longer than expected.",
    status: "delayed",
  },
};

export const Failed: Story = {
  args: {
    heading: "Import failed",
    message: "Try the import again.",
    progress: null,
    status: "failed",
  },
};

export const Complete: Story = {
  args: {
    heading: "Import complete",
    message: null,
    progress: 100,
    status: "ready",
  },
};
