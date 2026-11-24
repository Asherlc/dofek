import type { Meta, StoryObj } from "@storybook/react-native";
import type { ComponentType } from "react";
import { View } from "react-native";
import { AuthProvider } from "../../lib/auth-context";
import { type Provider, ProviderCard } from "./provider-card.tsx";
import { ProviderDataSourcesList } from "./provider-data-sources-list.tsx";

// AuthProvider is resolved to .storybook/mocks/auth-context in web Storybook
// via the Vite alias in .storybook/main.ts, avoiding heavy native dependencies.

const sampleProviders: Provider[] = [
  {
    id: "crimpd",
    label: "Crimpd",
    enabled: true,
    authStatus: "connected",
    authType: "credential",
    lastSyncAt: null,
    recentLogs: [],
    lastSuccessfulSyncAt: null,
    syncFreshness: null,
    importOnly: false,
    pushOnly: false,
  },
  {
    id: "ziva",
    label: "Ziva",
    enabled: true,
    authStatus: "not_connected",
    authType: "oauth",
    lastSyncAt: null,
    recentLogs: [],
    lastSuccessfulSyncAt: null,
    syncFreshness: null,
    importOnly: false,
    pushOnly: false,
  },
];

const meta = {
  title: "Providers/ProviderDataSourcesList",
  component: ProviderDataSourcesList,
  decorators: [
    (Story: ComponentType) => (
      <AuthProvider>
        <View style={{ padding: 16, backgroundColor: "#000" }}>
          <Story />
        </View>
      </AuthProvider>
    ),
  ],
} satisfies Meta<typeof ProviderDataSourcesList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    providers: sampleProviders,
    providersError: null,
    statsError: null,
    isLoading: false,
    renderProviderCard: (provider: Provider) => (
      <ProviderCard
        provider={provider}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={() => {}}
        onConnect={() => {}}
        onPress={() => {}}
      />
    ),
  },
};
