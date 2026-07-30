import type { Meta, StoryObj } from "@storybook/react-native";
import { ProviderSyncHistoryEntry } from "./ProviderSyncHistoryEntry";

const meta = {
  title: "Providers/ProviderSyncHistoryEntry",
  component: ProviderSyncHistoryEntry,
  args: {
    providerName: "WHOOP",
    entry: {
      id: "sync-log-01",
      syncedAt: "2026-07-24T12:00:00.000Z",
      dataType: "strength",
      status: "error",
      recordCount: null,
      durationMs: 1250,
      errorMessage: "OAuth token refresh returned invalid_grant",
      authFailureReason: "refresh_token_revoked",
    },
  },
} satisfies Meta<typeof ProviderSyncHistoryEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AuthorizationExpired: Story = {};

export const SuccessfulSync: Story = {
  args: {
    providerName: "Strava",
    entry: {
      id: "sync-log-02",
      syncedAt: "2026-07-24T13:00:00.000Z",
      dataType: "activities",
      status: "success",
      recordCount: 12,
      durationMs: 850,
      errorMessage: null,
      authFailureReason: null,
    },
  },
};

export const SyncedWithIssues: Story = {
  args: {
    providerName: "Oura",
    entry: {
      id: "sync-log-03",
      syncedAt: "2026-07-24T14:00:00.000Z",
      dataType: "daily_metrics",
      status: "degraded",
      recordCount: 8,
      durationMs: 1100,
      errorMessage: "Two daily summaries were unavailable",
      authFailureReason: null,
    },
  },
};
