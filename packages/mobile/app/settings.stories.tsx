import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { View } from "react-native";
import { within } from "storybook/test";
import { AuthProvider } from "../lib/auth-context";
import { trpc } from "../lib/trpc";
import SettingsScreen from "./settings";

const settingsModelCards = [
  ["exponentialMovingAverage", "Training Load Windows", "Past 365 days"],
  [
    "readinessWeights",
    "Readiness Score Weights",
    "Past 365 days after a 60-day rolling-baseline warm-up",
  ],
  [
    "sleepTarget",
    "Sleep Target",
    "Past 365 days; next-day recovery uses up to 60 days of baseline history",
  ],
  ["stressThresholds", "Stress Sensitivity", "Past 425 days, including rolling-baseline warm-up"],
  [
    "trainingImpulseConstants",
    "Heart Rate Effort Model",
    "All qualifying activities; the power reference uses the past 365 days",
  ],
].map(([key, title, dataWindow]) => ({
  key,
  title,
  description: `${title} personalization settings`,
  status: "default",
  lastSuccessfulFitAt: null,
  lastFitSummary: "No accepted personalized fit",
  dataWindow,
  dataSufficiency: "No accepted fit; more qualifying data is required",
  fitEvidence: "No accepted fit statistic is available.",
  uncertainty: "No calibrated uncertainty interval is available.",
  excludedData: ["Records without required inputs"],
}));

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

  queryClient.setQueryData([["auth", "passwordCredentialStatus"], { type: "query" }], {
    hasPassword: true,
  });

  // settings.get (unitSystem)
  queryClient.setQueryData([["settings", "get"], { input: { key: "unitSystem" }, type: "query" }], {
    key: "unitSystem",
    value: "metric",
  });

  // personalization.status (used by PersonalizationPanel)
  queryClient.setQueryData([["personalization", "status"], { type: "query" }], {
    isPersonalized: false,
    fittedAt: null,
    effective: {
      exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
      readinessWeights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      sleepTarget: { minutes: 480 },
      stressThresholds: {
        hrvThresholds: [-2.0, -1.5, -1.0],
        rhrThresholds: [2.0, 1.5, 1.0],
      },
      trainingImpulseConstants: { genderFactor: 1.92, exponent: 1.67 },
    },
    defaults: {
      exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
      readinessWeights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      sleepTarget: { minutes: 480 },
      stressThresholds: {
        hrvThresholds: [-2.0, -1.5, -1.0],
        rhrThresholds: [2.0, 1.5, 1.0],
      },
      trainingImpulseConstants: { genderFactor: 1.92, exponent: 1.67 },
    },
    parameters: {
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    },
    modelCards: settingsModelCards,
  });

  // settings.slackStatus (used by SlackIntegrationPanel)
  queryClient.setQueryData([["settings", "slackStatus"], { type: "query" }], {
    configured: true,
    connected: false,
    channelName: null,
  });
  queryClient.setQueryData([["billing", "status"], { type: "query" }], {
    hasFullAccess: false,
    access: {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-03",
      endDateExclusive: "2026-04-10",
    },
    stripeSubscriptionStatus: null,
    canManageBilling: false,
  });

  return { queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient } = createSeededProviders();
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: "http://127.0.0.1/storybook-trpc" })],
  });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Settings",
  component: SettingsScreen,
  parameters: {
    layout: "fullscreen",
  },
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

export const AccountPassword: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Account" }));
  },
};
