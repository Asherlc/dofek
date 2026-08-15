import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import CycleScreen from "../app/cycle";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

type CycleScenario = "populated" | "no-data" | "conflict" | "error";

const populatedPhase = {
  phase: "menstrual",
  dayOfCycle: 3,
  cycleLength: 28,
  estimate: {
    basis: "personal-cycle-average",
    completedCycleCount: 3,
    observedCycleLengthRange: { minimumDays: 27, maximumDays: 29 },
    phaseLabel: "Estimated Menstrual phase",
    cycleDayLabel: "Day 3 of an estimated 28-day cycle",
    dayBasisLabel: "Cycle day is counted from the latest provider cycle-start record.",
    methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
    uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 29 days.",
    limitationLabel: "No calibrated confidence score or next-period forecast is available.",
  },
  latestCycleStart: {
    id: "cycle-start:2026-08-01",
    startDate: "2026-08-01",
    sources: [
      {
        providerId: "apple_health",
        sourceName: "Cycle Source",
        sourceBundle: "com.example.cycle",
      },
    ],
  },
  availability: { status: "estimated", label: "Phase estimate available." },
};

const history = [
  populatedPhase.latestCycleStart,
  {
    id: "cycle-start:2026-07-04",
    startDate: "2026-07-04",
    sources: [
      { providerId: "apple_health", sourceName: "Cycle Source", sourceBundle: "com.example.cycle" },
      { providerId: "garmin", sourceName: null, sourceBundle: "com.garmin.connect" },
    ],
  },
];

function resultFor(path: string, scenario: CycleScenario): unknown {
  if (path === "menstrualCycle.history") return scenario === "populated" ? history : [];
  if (path !== "menstrualCycle.currentPhase") return undefined;
  if (scenario === "populated") return populatedPhase;
  if (scenario === "conflict") {
    return {
      phase: null,
      dayOfCycle: null,
      cycleLength: null,
      estimate: null,
      latestCycleStart: null,
      availability: {
        status: "conflicting-history",
        label: "Provider cycle-start records conflict: 2026-06-01 and 2026-06-20.",
      },
    };
  }
  return {
    phase: null,
    dayOfCycle: null,
    cycleLength: null,
    estimate: null,
    latestCycleStart: null,
    availability: {
      status: "no-history",
      label: "No cycle starts are available from provider records.",
    },
  };
}

function createMockLink(scenario: CycleScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (scenario === "error") {
        return createErrorObservable(
          TRPCClientError.from<AppRouter>(new Error("Cycle provider records are unavailable.")),
        );
      }
      const data = resultFor(op.path, scenario);
      if (data === undefined) {
        return createErrorObservable(
          TRPCClientError.from<AppRouter>(
            new Error(`Unhandled Storybook tRPC operation: ${op.path}`),
          ),
        );
      }
      return createDataObservable(data);
    };
}

function createDataObservable(data: unknown): OperationResultObservable<AppRouter, unknown> {
  const observable: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return observable;
    },
  };
  return observable;
}

function createErrorObservable(
  error: TRPCClientError<AppRouter>,
): OperationResultObservable<AppRouter, unknown> {
  const observable: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.error?.(error);
      return { unsubscribe: () => {} };
    },
    pipe() {
      return observable;
    },
  };
  return observable;
}

function CycleStoryFrame({ scenario }: { scenario: CycleScenario }) {
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
          <CycleScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Cycle",
  component: CycleScreen,
} satisfies Meta<typeof CycleScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { render: () => <CycleStoryFrame scenario="populated" /> };
export const NoData: Story = { render: () => <CycleStoryFrame scenario="no-data" /> };
export const Conflict: Story = { render: () => <CycleStoryFrame scenario="conflict" /> };
export const Error: Story = { render: () => <CycleStoryFrame scenario="error" /> };
