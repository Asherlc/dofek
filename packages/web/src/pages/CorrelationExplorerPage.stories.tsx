import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { CorrelationExplorerPage } from "./CorrelationExplorerPage.tsx";

type CorrelationScenario = "available" | "insufficient";

const interpretationWarning =
  "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.";

const metrics = [
  {
    id: "protein",
    label: "Protein",
    unit: "g",
    domain: "nutrition",
    description: "Daily protein intake",
    availabilityDescription: "Needs logged daily nutrition data.",
  },
  {
    id: "hrv",
    label: "Heart Rate Variability",
    unit: "ms",
    domain: "recovery",
    description: "Variation between heartbeats",
    availabilityDescription: "Needs a daily recovery measurement.",
  },
];

const availableResult = {
  analysisVersion: 2,
  availability: "available",
  spearmanRho: 0.72,
  regression: { slope: 0.42, intercept: 8, rSquared: 0.46 },
  dataPoints: [
    { x: 90, y: 46, date: "2026-07-15" },
    { x: 100, y: 49, date: "2026-07-16" },
    { x: 110, y: 55, date: "2026-07-17" },
    { x: 120, y: 57, date: "2026-07-18" },
    { x: 130, y: 63, date: "2026-07-19" },
  ],
  sampleCount: 5,
  coverage: {
    selectedDayCount: 90,
    eligiblePairDayCount: 90,
    observedXDayCount: 65,
    observedYDayCount: 61,
    pairedDayCount: 5,
    missingPairDayCount: 85,
  },
  uncertainty: {
    availability: "available",
    method: "circular_moving_block_bootstrap",
    level: 0.95,
    blockLength: 5,
    requestedReplicateCount: 2_000,
    attemptedReplicateCount: 2_000,
    validReplicateCount: 2_000,
    lower: 0.24,
    upper: 0.91,
  },
  xStats: { mean: 110, median: 110, stddev: 15.81, min: 90, max: 130, n: 5 },
  yStats: { mean: 54, median: 55, stddev: 6.52, min: 46, max: 63, n: 5 },
  insight: "Higher protein intake tended to coincide with higher heart rate variability.",
  interpretationWarning,
};

const insufficientResult = {
  analysisVersion: 2,
  availability: "insufficient",
  dataPoints: [],
  sampleCount: 0,
  additionalSamplesRequired: 5,
  coverage: {
    selectedDayCount: 90,
    eligiblePairDayCount: 90,
    observedXDayCount: 0,
    observedYDayCount: 0,
    pairedDayCount: 0,
    missingPairDayCount: 90,
  },
  uncertainty: {
    availability: "unavailable",
    method: "circular_moving_block_bootstrap",
    level: 0.95,
    blockLength: 5,
    requestedReplicateCount: 2_000,
    attemptedReplicateCount: 0,
    validReplicateCount: 0,
    reason: "insufficient_pairs",
  },
  insight:
    "Insufficient data to describe the relationship between Protein and Heart Rate Variability.",
  interpretationWarning,
};

const availableObservations = {
  items: [
    {
      x: {
        metricId: "protein",
        date: "2026-07-19",
        value: 130,
        contributors: [
          {
            kind: "aggregate_inputs",
            label: "Canonical daily nutrition inputs",
            providerIds: ["manual"],
            target: { type: "metric_family", family: "nutrition" },
          },
        ],
      },
      y: {
        metricId: "hrv",
        date: "2026-07-18",
        value: 63,
        contributors: [
          {
            kind: "aggregate_inputs",
            label: "Daily recovery aggregate inputs",
            providerIds: ["apple_health"],
            target: { type: "metric_family", family: "recovery" },
          },
        ],
      },
    },
  ],
  totalCount: 5,
  nextCursor: null,
};

const insufficientObservations = {
  items: [],
  totalCount: 0,
  nextCursor: null,
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
      } else if (path === "correlation.computeV2") {
        observer.next?.({
          result: { data: scenario === "available" ? availableResult : insufficientResult },
        });
      } else if (path === "correlation.observations") {
        observer.next?.({
          result: {
            data: scenario === "available" ? availableObservations : insufficientObservations,
          },
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
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: CorrelationExplorerPage });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/CorrelationExplorer",
  component: CorrelationExplorerPage,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof CorrelationExplorerPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = {
  render: () => <CorrelationStoryFrame scenario="available" />,
};

export const Insufficient: Story = {
  render: () => <CorrelationStoryFrame scenario="insufficient" />,
};

export const NarrowViewport: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  render: () => <CorrelationStoryFrame scenario="available" />,
};
