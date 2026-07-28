import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { mobileTrainingFixtureSchema } from "dofek-server/mobile-dashboard-contracts";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import StrainScreen from "./strain";

function localDateString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return formatDateYmd(date);
}

function localWeekStartString(dayOffset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return formatDateYmd(date);
}

function createMockWorkloadData() {
  const timeSeries = Array.from({ length: 7 }, (_, index) => {
    const isLatest = index === 6;
    return {
      date: localDateString(index - 6),
      dailyLoad: isLatest ? 450 : 330 + index * 18,
      strain: isLatest ? 12.5 : 10.2 + index * 0.3,
      acuteLoad: isLatest ? 380 : 350 + index * 5,
      chronicLoad: 400,
      workloadRatio: isLatest ? 0.95 : 0.88 + index * 0.01,
    };
  });

  return {
    context: {
      label: "Recent-to-baseline workload ratio",
      description:
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
      recentDays: 7,
      baselineDays: 28,
    },
    displayedStrain: 12.5,
    displayedDate: localDateString(),
    timeSeries,
  };
}

const mockActivities = [
  {
    id: "a1",
    name: "Morning Ride",
    activity_type: "cycling",
    started_at: `${localDateString()}T07:00:00.000Z`,
    ended_at: `${localDateString()}T08:30:00.000Z`,
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
    started_at: `${localDateString(-1)}T18:00:00.000Z`,
    ended_at: `${localDateString(-1)}T18:45:00.000Z`,
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
  const endDate = localDateString();
  const hasActivities = activities.length > 0;
  const workloadRatio = hasActivities
    ? createMockWorkloadData()
    : {
        context: createMockWorkloadData().context,
        displayedStrain: 0,
        displayedDate: null,
        timeSeries: [],
      };
  const fixture = mobileTrainingFixtureSchema.parse({
    input: { days: 30, endDate },
    data: {
      workloadRatio,
      strainTarget: hasActivities
        ? {
            targetStrain: 13.5,
            currentStrain: 12.5,
            currentStrainSource: "activity",
            currentPhysiologyLoad: 450,
            progressPercent: 93,
            zone: "Push",
            explanation: "Your recovery and training load support a productive training day.",
            dailyLoad: 450,
            acuteLoad: 380,
            chronicLoad: 400,
            workloadRatio: 0.95,
            readinessScore: 78,
          }
        : undefined,
      activities,
      weeklyVolume: hasActivities
        ? [
            { week: localWeekStartString(), activity_type: "cycling", count: 1, hours: 1.5 },
            {
              week: localWeekStartString(-1),
              activity_type: "running",
              count: 1,
              hours: 0.75,
            },
          ]
        : [],
      verticalAscent: [],
      climbing: {
        gradeProgression: [],
        volumeByGrade: [],
        sessionSummary: [],
      },
    },
  });

  queryClient.setQueryData(
    [["mobileDashboard", "training"], { input: { days: 30, endDate }, type: "query" }],
    fixture.data,
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
  title: "Pages/Strain",
  component: StrainScreen,
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
