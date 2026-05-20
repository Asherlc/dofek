import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import ActivitiesScreen from "./activities";

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const today = new Date().toLocaleDateString("en-CA");
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA");

  queryClient.setQueryData(
    [["calendar", "weekList"], { input: { weeks: 4, endDate: today }, type: "query" }],
    [
      {
        date: today,
        activities: [
          {
            id: "story-outdoor",
            name: "Morning Ride",
            activityType: "road_cycling",
            startedAt: `${today}T07:30:00Z`,
            endedAt: `${today}T09:00:00Z`,
            durationMin: 90,
            location: {
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              tileUrl: "https://tile.openstreetmap.org/13/1310/3170.png",
              distanceMeters: 32400,
              elevationGainM: 412,
            },
            calories: null,
            tss: 78.4,
            stats: [
              { label: "Training Stress Score", value: "78.4" },
              { label: "Calories", value: "—" },
            ],
          },
        ],
      },
      {
        date: yesterday,
        activities: [
          {
            id: "story-indoor",
            name: "Strength session",
            activityType: "strength",
            startedAt: `${yesterday}T17:00:00Z`,
            endedAt: `${yesterday}T17:45:00Z`,
            durationMin: 45,
            location: null,
            calories: 380,
            tss: 42.1,
            stats: [
              { label: "Training Stress Score", value: "42.1" },
              { label: "Calories", value: "380 kcal" },
            ],
          },
        ],
      },
    ],
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
