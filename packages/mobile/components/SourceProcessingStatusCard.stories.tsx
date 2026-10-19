import type { Meta, StoryObj } from "@storybook/react-native";
import { Text } from "react-native";
import { colors } from "../theme";
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
export const WithDetails: Story = {
  args: {
    message: null,
    details: <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Last ready: 5m ago</Text>,
  },
};

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

export const Blocked: Story = {
  name: "Waiting to continue",
  args: {
    heading: "Syncing Garmin is waiting to continue",
    message: "Your existing data is still available.",
    status: "blocked",
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
