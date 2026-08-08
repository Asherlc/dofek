import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { inferRouterClient, OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import CycleScreen from "../app/cycle";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

type CurrentPhaseOutput = Awaited<
  ReturnType<inferRouterClient<AppRouter>["menstrualCycle"]["currentPhase"]["query"]>
>;

const currentPhase = {
  phase: "menstrual",
  dayOfCycle: 3,
  cycleLength: 28,
  estimate: {
    basis: "personal-cycle-average",
    completedCycleCount: 3,
    observedCycleLengthRange: {
      minimumDays: 27,
      maximumDays: 29,
    },
    phaseLabel: "Estimated Menstrual phase",
    cycleDayLabel: "Day 3 of an estimated 28-day cycle",
    dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
    methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
    uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 29 days.",
    limitationLabel: "No calibrated confidence score or next-period forecast is available.",
  },
  availability: {
    status: "estimated",
    label: "Phase estimate available from recorded cycle history.",
  },
} satisfies CurrentPhaseOutput;

const sparseCurrentPhase = {
  phase: null,
  dayOfCycle: null,
  cycleLength: null,
  estimate: null,
  availability: {
    status: "sparse-history",
    label:
      "Not enough recorded history for a phase estimate. At least 3 completed cycles are needed.",
  },
} satisfies CurrentPhaseOutput;

const irregularCurrentPhase = {
  phase: null,
  dayOfCycle: null,
  cycleLength: null,
  estimate: null,
  availability: {
    status: "irregular-history",
    label:
      "No phase estimate is shown because recorded cycle lengths do not support a regular-cycle model (observed range: 22 to 34 days).",
  },
} satisfies CurrentPhaseOutput;

const periodHistory = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    durationDays: 5,
    durationLabel: "5 days",
    notes: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    startDate: "2026-06-03",
    endDate: "2026-06-07",
    durationDays: 5,
    durationLabel: "5 days",
    notes: null,
  },
];

function createMockLink(
  phaseFixture: CurrentPhaseOutput,
  historyFixture: typeof periodHistory,
): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, phaseFixture, historyFixture);
}

function createMockObservable(
  path: string,
  phaseFixture: CurrentPhaseOutput,
  historyFixture: typeof periodHistory,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "menstrualCycle.currentPhase") {
        observer.next?.({ result: { data: phaseFixture } });
      } else if (path === "menstrualCycle.history") {
        observer.next?.({ result: { data: historyFixture } });
      } else if (path === "menstrualCycle.logPeriod") {
        observer.next?.({
          result: {
            data: {
              id: "33333333-3333-4333-8333-333333333333",
              startDate: "2026-07-27",
              endDate: null,
              durationDays: null,
              durationLabel: null,
              notes: null,
            },
          },
        });
      } else if (path === "menstrualCycle.updatePeriod") {
        observer.next?.({ result: { data: historyFixture[0] } });
      } else if (path === "menstrualCycle.deletePeriod") {
        observer.next?.({ result: { data: { deleted: true } } });
      } else {
        throw new Error(`Unhandled cycle story tRPC operation: ${path}`);
      }
      observer.complete?.();
      return { unsubscribe() {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function CycleStoryFrame({
  phaseFixture = currentPhase,
  historyFixture = periodHistory,
}: {
  phaseFixture?: CurrentPhaseOutput;
  historyFixture?: typeof periodHistory;
}) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          // Story fixtures are immutable, so background refetches should not replace them.
          queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        },
      }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(phaseFixture, historyFixture)] }),
    [historyFixture, phaseFixture],
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
  title: "Pages/CycleTracking",
  component: CycleScreen,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof CycleScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CurrentPhase: Story = {
  render: () => <CycleStoryFrame />,
};

export const SparseHistory: Story = {
  render: () => <CycleStoryFrame phaseFixture={sparseCurrentPhase} />,
};

export const IrregularHistory: Story = {
  render: () => <CycleStoryFrame phaseFixture={irregularCurrentPhase} />,
};

export const EmptyHistory: Story = {
  render: () => <CycleStoryFrame historyFixture={[]} phaseFixture={sparseCurrentPhase} />,
};
