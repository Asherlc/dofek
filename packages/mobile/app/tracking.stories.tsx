import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import TrackingScreen from "./tracking";

type TrackingScenario = "available" | "empty" | "loading";

const trendEvidence = {
  window: {
    startDate: "2026-07-21",
    endDate: "2026-07-24",
    dayCount: 4,
    gapRepresentation: "explicit_daily",
  },
  statement:
    "3 exact observations across 2 of 4 days. Missing days indicate no journal value was recorded.",
  uncertainty: {
    status: "unavailable",
    statement: "Uncertainty interval: not available for raw journal observations.",
  },
  series: [
    {
      questionSlug: "alcohol",
      displayName: "Alcohol",
      dataType: "boolean",
      unit: null,
      observationCount: 2,
      observedDayCount: 2,
      missingDayCount: 2,
      statement: "2 exact observations across 2 of 4 days; 2 days have no recorded value.",
      points: [
        { date: "2026-07-21", value: null, source: null },
        {
          date: "2026-07-22",
          value: 0,
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
        },
        { date: "2026-07-23", value: null, source: null },
        {
          date: "2026-07-24",
          value: 1,
          source: { providerId: "manual_review", label: "Manual review" },
        },
      ],
    },
    {
      questionSlug: "energy",
      displayName: "Energy",
      dataType: "numeric",
      unit: "/10",
      observationCount: 1,
      observedDayCount: 1,
      missingDayCount: 3,
      statement: "1 exact observation across 1 of 4 days; 3 days have no recorded value.",
      points: [
        { date: "2026-07-21", value: null, source: null },
        { date: "2026-07-22", value: null, source: null },
        { date: "2026-07-23", value: null, source: null },
        {
          date: "2026-07-24",
          value: 8,
          source: { providerId: "dofek", label: "Dofek" },
        },
      ],
    },
  ],
};

function createMockLink(scenario: TrackingScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path === "journal.trends" && scenario === "loading") {
        return createLoadingObservable();
      }
      if (op.path === "journal.trends") {
        return createMockObservable(
          scenario === "available"
            ? trendEvidence
            : {
                ...trendEvidence,
                statement: "No numeric or Yes/No journal observations in this window.",
                series: [],
              },
        );
      }
      return createErrorObservable(
        TRPCClientError.from<AppRouter>(
          new Error(`Unhandled Storybook tRPC operation: ${op.path}`),
        ),
      );
    };
}

function createMockObservable(data: unknown): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function createLoadingObservable(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe() {
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function createErrorObservable(
  error: TRPCClientError<AppRouter>,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.error?.(error);
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function TrackingStoryFrame({ scenario }: { scenario: TrackingScenario }) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <TrackingScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/JournalTrends",
  component: TrackingScreen,
} satisfies Meta<typeof TrackingScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AvailableWithMissingDays: Story = {
  render: () => <TrackingStoryFrame scenario="available" />,
};

export const Empty: Story = {
  render: () => <TrackingStoryFrame scenario="empty" />,
};

export const Loading: Story = {
  render: () => <TrackingStoryFrame scenario="loading" />,
};
