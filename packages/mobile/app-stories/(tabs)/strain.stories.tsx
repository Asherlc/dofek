import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import { mobileTrainingFixtureSchema } from "dofek-server/mobile-dashboard-contracts";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { createFixtureDates, type FixtureDates } from "../../app/(tabs)/_fixture-dates";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "../../app/(tabs)/_processing-status-story-fixture";
import StrainScreen from "../../app/(tabs)/strain";
import { trpc } from "../../lib/trpc";

const STRAIN_COMPANION_RESPONSES = {
  "training.hrZones": {
    maxHr: 190,
    weeks: [],
    intensityDistribution: {
      model: "karvonen-five-zone",
      activityScope: "endurance",
      totalSeconds: 0,
      zones: [],
      explanation: "No intensity samples in this fixture.",
    },
  },
  "efficiency.polarizationTrend": {
    model: "treff-three-zone",
    activityScope: "cycling",
    threshold: 2,
    maxHr: 190,
    weeks: [],
    explanation: "No cycling polarization samples in this fixture.",
    method: {
      formula: "Fixture formula.",
      zoneBasis: "Fixture zones.",
      calculationChoice: "Fixture calculation.",
      interpretation: "Fixture interpretation.",
      source: {
        title: "Treff source",
        url: "https://doi.org/10.3389/fphys.2019.00707",
      },
    },
  },
  "cyclingAdvanced.trainingMonotony": [],
} satisfies Parameters<typeof createProcessingStatusStoryLink>[1];

function createTrainingFailureStoryLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) => {
      if (op.path !== "mobileDashboard.training") {
        return next(op);
      }

      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          observer.error?.(
            TRPCClientError.from<AppRouter>(new Error("Training analytics are unavailable.")),
          );
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function createMockWorkloadData(dates: FixtureDates) {
  const timeSeries = Array.from({ length: 7 }, (_, index) => {
    const isLatest = index === 6;
    return {
      date: dates.date(index - 6),
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
    displayedDate: dates.date(),
    timeSeries,
  };
}

function createMockActivities(dates: FixtureDates) {
  return [
    {
      id: "a1",
      name: "Morning Ride",
      canonical_type: "cycling",
      started_at: `${dates.date()}T07:00:00.000Z`,
      ended_at: `${dates.date()}T08:30:00.000Z`,
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
      canonical_type: "running",
      started_at: `${dates.date(-1)}T18:00:00.000Z`,
      ended_at: `${dates.date(-1)}T18:45:00.000Z`,
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
}

function createSeededProviders(hasActivities: boolean, trainingUnavailable: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const dates = createFixtureDates(new Date());
  const endDate = dates.date();
  const mockWorkloadData = createMockWorkloadData(dates);
  const activities = hasActivities ? createMockActivities(dates) : [];
  const workloadRatio = hasActivities
    ? mockWorkloadData
    : {
        context: mockWorkloadData.context,
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
            { week: dates.weekStart(), canonical_type: "cycling", count: 1, hours: 1.5 },
            {
              week: dates.weekStart(-1),
              canonical_type: "running",
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

  if (!trainingUnavailable) {
    queryClient.setQueryData(
      [["mobileDashboard", "training"], { input: { days: 30, endDate }, type: "query" }],
      fixture.data,
    );
  }

  const processingStatus = seedReadyProcessingStatus(queryClient, [
    "activity",
    "recovery",
    "training",
  ]);

  return { processingStatus, queryClient };
}

function MockProviders({
  children,
  trainingUnavailable = false,
  withActivities = false,
}: {
  children: React.ReactNode;
  trainingUnavailable?: boolean;
  withActivities?: boolean;
}) {
  const { queryClient, trpcClient } = useMemo(() => {
    const seededProviders = createSeededProviders(withActivities, trainingUnavailable);
    return {
      queryClient: seededProviders.queryClient,
      trpcClient: trpc.createClient({
        links: [
          ...(trainingUnavailable ? [createTrainingFailureStoryLink()] : []),
          createProcessingStatusStoryLink(
            seededProviders.processingStatus,
            STRAIN_COMPANION_RESPONSES,
          ),
        ],
      }),
    };
  }, [trainingUnavailable, withActivities]);

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
      <MockProviders withActivities>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
};

export const TrainingUnavailable: Story = {
  decorators: [
    (Story) => (
      <MockProviders trainingUnavailable>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
};
