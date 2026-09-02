import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { within } from "storybook/test";
import ActivitiesScreen from "../../app/(tabs)/activities";
import { trpc } from "../../lib/trpc";

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

function createStoryData() {
  const today = formatDateYmd();
  const yesterday = formatDateYmd(new Date(Date.now() - 86_400_000));
  const queryInput = { weeks: 4, endDate: today };

  const weekList = [
    {
      date: today,
      activities: [
        {
          id: "story-outdoor",
          name: "Morning Ride",
          activityType: "road_cycling",
          startedAt: `${today}T07:30:00Z`,
          endedAt: `${today}T09:00:00Z`,
          localTimeContext: {
            timezone: "America/Los_Angeles",
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "device_timezone",
          },
          durationMin: 90,
          source: {
            primarySourceLabel: "Garmin Connect",
            sourceCount: 2,
            overlapSummary: "2 matched source records · Garmin Connect selected by source priority",
          },
          lastProcessedAt: `${today}T09:05:00Z`,
          distanceMeters: 32400,
          distanceState: { status: "available" },
          elevationGainM: 412,
          elevationState: { status: "available" },
          location: {
            centroidLat: 37.7749,
            centroidLng: -122.4194,
            mapPreview,
          },
          tss: 78.4,
          stats: [{ status: "available", label: "Training Stress Score", value: "78.4" }],
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
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: null,
            endUtcOffsetMinutes: null,
            source: "unknown",
          },
          durationMin: 45,
          source: {
            primarySourceLabel: "Strong (via Apple Health)",
            sourceCount: 1,
            overlapSummary: null,
          },
          lastProcessedAt: `${yesterday}T17:48:00Z`,
          distanceMeters: null,
          distanceState: { status: "missing", reason: "Distance not recorded" },
          elevationGainM: null,
          elevationState: { status: "missing", reason: "Elevation not recorded" },
          location: null,
          tss: null,
          stats: [
            {
              status: "missing",
              label: "Training Stress Score",
              reason:
                "Record average power, or record average heart rate and set maximum heart rate.",
            },
          ],
        },
      ],
    },
  ];

  const activityOverview = {
    activityCount: 2,
    totalMinutes: 135,
    totalDistanceMeters: 32400,
    totalDistanceState: { status: "available" },
    totalElevationGainM: 412,
    totalElevationState: { status: "available" },
    activityTypes: ["road_cycling", "strength"],
  };

  const calendarData = [
    {
      date: yesterday,
      activityCount: 1,
      totalMinutes: 45,
      activityTypes: ["strength"],
      trainingTimeBand: "moderate" as const,
      trainingTimeMeaning: "Moderate recorded training volume.",
    },
    {
      date: today,
      activityCount: 1,
      totalMinutes: 90,
      activityTypes: ["road_cycling"],
      trainingTimeBand: "high" as const,
      trainingTimeMeaning:
        "High training volume; compare with recovery before stacking another hard day.",
    },
  ];

  const processingStatus = {
    generatedAt: `${today}T12:00:00.000Z`,
    scope: { providerId: null, datasets: ["activity"] },
    overallStatus: "ready" as const,
    datasets: [
      {
        key: "activity",
        label: "Activities",
        status: "ready" as const,
        currentStage: null,
        progressPercentage: null,
        lastAdvancedAt: null,
        lastReadyAt: `${today}T12:00:00.000Z`,
        lastFailedAt: null,
      },
    ],
    operations: [],
  };

  return { today, queryInput, weekList, activityOverview, calendarData, processingStatus };
}

function createMockLink(storyData: ReturnType<typeof createStoryData>): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, storyData);
}

function createMockObservable(
  path: string,
  storyData: ReturnType<typeof createStoryData>,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "calendar.weekList") {
        observer.next?.({ result: { data: storyData.weekList } });
      } else if (path === "calendar.activityOverview") {
        observer.next?.({ result: { data: storyData.activityOverview } });
      } else if (path === "calendar.calendarData") {
        observer.next?.({ result: { data: storyData.calendarData } });
      } else if (path === "processing.status") {
        observer.next?.({ result: { data: storyData.processingStatus } });
      } else {
        throw new Error(`Unhandled activities story tRPC operation: ${path}`);
      }
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function MockProviders({ children }: { children: React.ReactNode }) {
  const storyData = useMemo(() => createStoryData(), []);
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(
      [["calendar", "weekList"], { input: storyData.queryInput, type: "query" }],
      storyData.weekList,
    );
    client.setQueryData(
      [["calendar", "activityOverview"], { input: storyData.queryInput, type: "query" }],
      storyData.activityOverview,
    );
    client.setQueryData(
      [["calendar", "calendarData"], { input: { days: 28 }, type: "query" }],
      storyData.calendarData,
    );
    client.setQueryData(
      [["processing", "status"], { input: { datasets: ["activity"] }, type: "query" }],
      storyData.processingStatus,
    );
    return client;
  }, [storyData]);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(storyData)] }),
    [storyData],
  );

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

export const SelectionMode: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Select activities" }),
    );
  },
};
