import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import CorrelationScreen from "./correlation";

type CorrelationScenario = "available" | "insufficient";

const metrics = [
  {
    id: "protein",
    label: "Protein",
    unit: "g",
    domain: "nutrition",
    description: "Daily protein intake",
  },
  {
    id: "hrv",
    label: "Heart Rate Variability",
    unit: "ms",
    domain: "recovery",
    description: "Variation between heartbeats",
  },
];

const availableResult = {
  availability: "available",
  spearmanRho: 0.72,
  spearmanPValue: 0.018,
  pearsonR: 0.68,
  pearsonPValue: 0.026,
  regression: { slope: 0.42, intercept: 8, rSquared: 0.46 },
  dataPoints: [
    { x: 90, y: 46, date: "2026-07-15" },
    { x: 100, y: 49, date: "2026-07-16" },
    { x: 110, y: 55, date: "2026-07-17" },
    { x: 120, y: 57, date: "2026-07-18" },
    { x: 130, y: 63, date: "2026-07-19" },
  ],
  sampleCount: 5,
  xStats: { mean: 110, median: 110, stddev: 15.81, min: 90, max: 130, n: 5 },
  yStats: { mean: 54, median: 55, stddev: 6.52, min: 46, max: 63, n: 5 },
  insight: "Higher protein intake tended to coincide with higher heart rate variability.",
  confidenceLevel: "early",
  correlationColor: "#34d399",
};

const insufficientResult = {
  availability: "insufficient",
  dataPoints: [],
  sampleCount: 0,
  additionalSamplesRequired: 5,
  insight:
    "Insufficient data to analyze the relationship between Protein and Heart Rate Variability.",
  confidenceLevel: "insufficient",
  correlationColor: "#71717a",
};

function createMockLink(scenario: CorrelationScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: CorrelationScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "correlation.metrics") {
        observer.next?.({ result: { data: metrics } });
      } else if (path === "correlation.compute") {
        observer.next?.({
          result: { data: scenario === "available" ? availableResult : insufficientResult },
        });
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

function CorrelationStoryFrame({ scenario }: { scenario: CorrelationScenario }) {
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
          <CorrelationScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/CorrelationExplorer",
  component: CorrelationScreen,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof CorrelationScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = {
  render: () => <CorrelationStoryFrame scenario="available" />,
};

export const Insufficient: Story = {
  render: () => <CorrelationStoryFrame scenario="insufficient" />,
};
