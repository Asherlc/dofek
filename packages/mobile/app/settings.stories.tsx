import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import SettingsScreen from "./settings";

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  // sync.providers — connected providers shown in Data Sources card
  queryClient.setQueryData(
    [["sync", "providers"], { type: "query" }],
    [
      {
        id: "strava",
        name: "Strava",
        authType: "oauth",
        authorized: true,
        lastSyncedAt: "2026-04-03T12:00:00Z",
        importOnly: false,
        needsReauth: false,
      },
      {
        id: "wahoo",
        name: "Wahoo",
        authType: "oauth",
        authorized: true,
        lastSyncedAt: "2026-04-03T11:30:00Z",
        importOnly: false,
        needsReauth: false,
      },
      {
        id: "whoop",
        name: "WHOOP",
        authType: "custom:whoop",
        authorized: true,
        lastSyncedAt: "2026-04-03T10:00:00Z",
        importOnly: false,
        needsReauth: false,
      },
      {
        id: "garmin",
        name: "Garmin",
        authType: "custom:garmin",
        authorized: false,
        lastSyncedAt: null,
        importOnly: false,
        needsReauth: false,
      },
    ],
  );

  // auth.linkedAccounts
  queryClient.setQueryData(
    [["auth", "linkedAccounts"], { type: "query" }],
    [
      { id: "acct-1", authProvider: "strava", email: "user@example.com" },
      { id: "acct-2", authProvider: "apple", email: "user@icloud.com" },
      { id: "acct-3", authProvider: "google", email: "user@gmail.com" },
    ],
  );

  // settings.get (unitSystem)
  queryClient.setQueryData([["settings", "get"], { input: { key: "unitSystem" }, type: "query" }], {
    key: "unitSystem",
    value: "metric",
  });

  // personalization.status (used by PersonalizationPanel)
  queryClient.setQueryData([["personalization", "status"], { type: "query" }], {
    status: "personalized",
    updatedAt: "2026-04-03T08:00:00Z",
    parameters: {
      fitnessWindow: { value: 42, isDefault: true },
      fatigueWindow: { value: 7, isDefault: true },
      readinessWeights: {
        value: {
          heartRateVariability: 0.5,
          restingHeartRate: 0.2,
          sleep: 0.15,
          respiratoryRate: 0.15,
        },
        isDefault: true,
      },
    },
  });

  // settings.slackStatus (used by SlackIntegrationPanel)
  queryClient.setQueryData([["settings", "slackStatus"], { type: "query" }], {
    connected: false,
    channelName: null,
  });

  return { queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient } = createSeededProviders();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Pages/Settings",
  component: SettingsScreen,
  decorators: [
    (Story) => (
      <MockProviders>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof SettingsScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
