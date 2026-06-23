import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import ActivitiesScreen from "./activities";

const mapPreview = {
  width: 1024,
  height: 576,
  tiles: [
    {
      url: "https://tile.openstreetmap.org/19/83856/202646.png",
      x: -179.332,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202646.png",
      x: 76.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202646.png",
      x: 332.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202646.png",
      x: 588.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202646.png",
      x: 844.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83856/202647.png",
      x: -179.332,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202647.png",
      x: 76.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202647.png",
      x: 332.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202647.png",
      x: 588.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202647.png",
      x: 844.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83856/202648.png",
      x: -179.332,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202648.png",
      x: 76.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202648.png",
      x: 332.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202648.png",
      x: 588.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202648.png",
      x: 844.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
  ],
  routePath: [
    { x: 288.304, y: 453.089 },
    { x: 512, y: 311.585 },
    { x: 735.696, y: 122.911 },
  ],
};

function createSeededProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const today = formatDateYmd();
  const yesterday = formatDateYmd(new Date(Date.now() - 86_400_000));
  const queryInput = { weeks: 4, endDate: today };

  queryClient.setQueryData(
    [["calendar", "weekList"], { input: queryInput, type: "query" }],
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
              mapPreview,
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

  queryClient.setQueryData(
    [["calendar", "activityOverview"], { input: queryInput, type: "query" }],
    {
      activityCount: 2,
      totalMinutes: 135,
      totalDistanceMeters: 32400,
      totalElevationGainM: 412,
      activityTypes: ["road_cycling", "strength"],
    },
  );

  return { queryClient };
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const { queryClient } = createSeededProviders();
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: "http://127.0.0.1/storybook-trpc" })],
  });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Activities",
  component: ActivitiesScreen,
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
} satisfies Meta<typeof ActivitiesScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
