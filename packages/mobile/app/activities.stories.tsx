import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import ActivitiesScreen from "./activities";

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  // Pre-seed the cache with mock activity data
  queryClient.setQueryData(
    [["activity", "list"], { input: { days: 90, limit: 20, offset: 0 }, type: "query" }],
    {
      items: [
        {
          id: "story-1",
          activity_type: "running",
          started_at: "2026-03-31T08:00:00Z",
          ended_at: "2026-03-31T08:45:00Z",
          name: "Morning Run",
          provider_id: "apple_health",
          source_providers: ["apple_health"],
          avg_hr: 152,
          max_hr: 175,
          avg_power: null,
          distance_meters: 8500,
        },
        {
          id: "story-2",
          activity_type: "cycling",
          started_at: "2026-03-30T14:00:00Z",
          ended_at: "2026-03-30T15:30:00Z",
          name: "Afternoon Ride",
          provider_id: "wahoo",
          source_providers: ["wahoo"],
          avg_hr: 138,
          max_hr: 165,
          avg_power: 210,
          distance_meters: 32400,
        },
      ],
      totalCount: 2,
    },
  );

  return { queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient } = createSeededProviders();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Pages/Activities",
  component: ActivitiesScreen,
  decorators: [
    (Story) => (
      <MockProviders>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof ActivitiesScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
