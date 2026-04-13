import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import StrainScreen from "./strain";

const mockWorkloadData = {
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
};

const mockActivities = [
  {
    id: "a1",
    name: "Morning Ride",
    activity_type: "cycling",
    started_at: "2026-03-31T07:00:00.000Z",
    ended_at: "2026-03-31T08:30:00.000Z",
    avg_hr: 148,
    max_hr: 176,
    avg_power: 235,
    max_power: 580,
    avg_cadence: 88,
    hr_samples: 5400,
    power_samples: 5400,
    distance_meters: 42000,
  },
  {
    id: "a2",
    name: "Evening Run",
    activity_type: "running",
    started_at: "2026-03-30T18:00:00.000Z",
    ended_at: "2026-03-30T18:45:00.000Z",
    avg_hr: 155,
    max_hr: 172,
    avg_power: null,
    max_power: null,
    avg_cadence: null,
    hr_samples: 2700,
    power_samples: null,
    distance_meters: 7500,
  },
];

function createSeededProviders(activities: unknown[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  queryClient.setQueryData(
    [["recovery", "workloadRatio"], { input: { days: 30 }, type: "query" }],
    mockWorkloadData,
  );

  queryClient.setQueryData(
    [["training", "activityStats"], { input: { days: 30 }, type: "query" }],
    activities,
  );

  queryClient.setQueryData(
    [["training", "weeklyVolume"], { input: { days: 30 }, type: "query" }],
    [],
  );

  return { queryClient };
}

function MockProviders({
  children,
  activities = [],
}: {
  children: React.ReactNode;
  activities?: unknown[];
}) {
  const { queryClient } = createSeededProviders(activities);
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

export const WithActivities: Story = {
  decorators: [
    (Story) => (
      <MockProviders activities={mockActivities}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
};
