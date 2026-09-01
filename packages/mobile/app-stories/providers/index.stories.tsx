import type { Meta, StoryObj } from "@storybook/react-native";
import type { ComponentType } from "react";
import { View } from "react-native";
import { ProviderCard } from "../../app/providers/provider-card.tsx";
import { AuthProvider } from "../../lib/auth-context";

// ── ProviderCard ──
// AuthProvider is resolved to .storybook/mocks/auth-context in web Storybook
// via the Vite alias in .storybook/main.ts, avoiding heavy native dependencies.

const providerCardMeta = {
  title: "Providers/ProviderCard",
  component: ProviderCard,
  args: {
    provider: {
      id: "wahoo",
      label: "Wahoo",
      enabled: true,
      authStatus: "connected" as const,
      authType: "oauth",
      lastSyncAt: new Date(Date.now() - 3600_000).toISOString(),
      lastSuccessfulSyncAt: new Date(Date.now() - 3600_000).toISOString(),
      syncFreshness: {
        status: "current",
        label: "Sync current",
      },
      importOnly: false,
      pushOnly: false,
    },
    stats: undefined,
    syncing: false,
    syncProgress: undefined,
    onSync: () => {},
    onConnect: () => {},
    onPress: () => {},
  },
  decorators: [
    (Story: ComponentType) => (
      <AuthProvider>
        <View style={{ padding: 16, backgroundColor: "#000" }}>
          <Story />
        </View>
      </AuthProvider>
    ),
  ],
} satisfies Meta<typeof ProviderCard>;

export default providerCardMeta;

type ProviderCardStory = StoryObj<typeof providerCardMeta>;

export const Connected: ProviderCardStory = {};

export const NotConnected: ProviderCardStory = {
  args: {
    provider: {
      id: "strava",
      label: "Strava",
      enabled: false,
      authStatus: "not_connected",
      authType: "oauth",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: false,
      pushOnly: false,
    },
  },
};

export const Expired: ProviderCardStory = {
  args: {
    provider: {
      id: "polar",
      label: "Polar",
      enabled: true,
      authStatus: "expired",
      authType: "oauth",
      lastSyncAt: new Date(Date.now() - 86400_000 * 7).toISOString(),
      lastSuccessfulSyncAt: new Date(Date.now() - 86400_000 * 7).toISOString(),
      syncFreshness: {
        status: "overdue",
        label: "Sync overdue",
        description: "The last successful sync is overdue.",
      },
      importOnly: false,
      pushOnly: false,
    },
  },
};

export const Syncing: ProviderCardStory = {
  args: {
    syncing: true,
    syncProgress: { percentage: 45, message: "Fetching activities..." },
  },
};

export const SyncingNoProgress: ProviderCardStory = {
  args: {
    syncing: true,
    syncProgress: { message: "Preparing sync..." },
  },
};

export const ImportOnly: ProviderCardStory = {
  args: {
    provider: {
      id: "strong-csv",
      label: "Strong",
      enabled: false,
      authStatus: "connected",
      authType: "none",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: true,
      pushOnly: false,
    },
  },
};

export const GarminDumpImport: ProviderCardStory = {
  args: {
    provider: {
      id: "garmin-dump",
      label: "Garmin Dump",
      enabled: false,
      authStatus: "connected",
      authType: "none",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: true,
      pushOnly: false,
    },
    onImport: () => {},
  },
};

export const FitFileImport: ProviderCardStory = {
  args: {
    provider: {
      id: "fit-file",
      label: "FIT File",
      enabled: false,
      authStatus: "connected",
      authType: "none",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: true,
      pushOnly: false,
    },
    onImport: () => {},
  },
};

export const AppleHealthImportOnly: ProviderCardStory = {
  args: {
    provider: {
      id: "apple_health",
      label: "Apple Health",
      enabled: false,
      authStatus: "connected",
      authType: "none",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: true,
      pushOnly: false,
    },
  },
};

export const PushOnly: ProviderCardStory = {
  args: {
    provider: {
      id: "whoop-ble",
      label: "WHOOP BLE",
      enabled: false,
      authStatus: "connected",
      authType: "none",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: false,
      pushOnly: true,
    },
  },
};

export const AppleHealthConnected: ProviderCardStory = {
  args: {
    provider: {
      id: "apple_health",
      label: "Apple Health",
      enabled: true,
      authStatus: "connected",
      authType: "none",
      lastSyncAt: new Date(Date.now() - 600_000).toISOString(),
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      importOnly: false,
      pushOnly: false,
    },
  },
};

export const NeverSynced: ProviderCardStory = {
  args: {
    provider: {
      id: "whoop",
      label: "WHOOP",
      enabled: true,
      authStatus: "connected",
      authType: "custom:whoop",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: {
        status: "unknown",
        label: "Sync status unknown",
        description: "No successful sync has been recorded.",
      },
      importOnly: false,
      pushOnly: false,
    },
  },
};

export const StaleProvider: ProviderCardStory = {
  name: "Stale provider",
  tags: ["review-scenario", "review-scenario-stale-provider"],
  args: {
    provider: {
      id: "whoop",
      label: "WHOOP",
      enabled: true,
      authStatus: "connected",
      authType: "custom:whoop",
      lastSyncAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      lastSuccessfulSyncAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      syncFreshness: {
        status: "overdue",
        label: "Sync overdue",
        description: "The last successful sync is overdue.",
      },
      importOnly: false,
      pushOnly: false,
    },
  },
};
