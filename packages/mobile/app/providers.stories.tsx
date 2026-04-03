import type { Meta, StoryObj } from "@storybook/react-native";
import type { ComponentType } from "react";
import { View } from "react-native";
import { ProviderCard } from "./providers";

// ── ProviderCard ──

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
      importOnly: false,
    },
    stats: undefined,
    syncing: false,
    syncProgress: undefined,
    onSync: () => {},
    onFullSync: () => {},
    onConnect: () => {},
    onPress: () => {},
  },
  decorators: [
    (Story: ComponentType) => (
      <View style={{ padding: 16, backgroundColor: "#000" }}>
        <Story />
      </View>
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
      importOnly: false,
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
      importOnly: false,
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
      importOnly: true,
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
      importOnly: false,
    },
  },
};
