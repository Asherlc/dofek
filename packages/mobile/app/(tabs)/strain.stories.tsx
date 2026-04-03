import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import StrainScreen from "./strain";

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  // Pre-seed the cache with mock workload data
  queryClient.setQueryData(
    [["recovery", "workloadRatio"], { input: { days: 30 }, type: "query" }],
    {
      displayedStrain: 12.5,
      displayedDate: "2026-03-31",
      timeSeries: [
        {
          date: "2026-03-31",
          dailyLoad: 450,
          strain: 12.5,
          acuteLoad: 380,
          chronicLoad: 400,
          workloadRatio: 0.95,
        },
      ],
    },
  );

  queryClient.setQueryData(
    [["training", "activityStats"], { input: { days: 30 }, type: "query" }],
    [],
  );

  queryClient.setQueryData(
    [["training", "weeklyVolume"], { input: { days: 30 }, type: "query" }],
    [],
  );

  return { queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient } = createSeededProviders();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Pages/Strain",
  component: StrainScreen,
  decorators: [
    (Story) => (
      <MockProviders>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof StrainScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
