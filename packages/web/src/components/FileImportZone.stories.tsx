import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileImportZone } from "./FileImportZone.tsx";

const meta = {
  title: "Providers/FileImportZone",
  component: FileImportZone,
  args: {
    providerId: "garmin-dump",
    importType: "garmin-dump",
    title: "Garmin Dump",
    description: ".zip account export from Garmin",
    accept: ".zip",
  },
} satisfies Meta<typeof FileImportZone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithRecentImport: Story = {
  args: {
    recentLogs: [
      {
        status: "success",
        syncedAt: "2026-07-19T12:00:00.000Z",
        recordCount: 120,
        durationMs: 4_200,
        errorMessage: null,
        authFailureReason: null,
      },
    ],
  },
};
