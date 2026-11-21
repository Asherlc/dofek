import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import type { TrainingHrZonesResult } from "dofek-server/types";
import { type ComponentProps, useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { TrainingInsightsPanel } from "./TrainingInsightsPanel.tsx";

interface TrainingInsightsScenario {
  volume: unknown[];
  hrZones: TrainingHrZonesResult;
  loading?: boolean;
}

const volume = [
  { week: "2026-06-01", canonical_type: "running", count: 3, hours: 3.2 },
  { week: "2026-06-01", canonical_type: "strength", count: 2, hours: 1.8 },
  { week: "2026-06-08", canonical_type: "running", count: 4, hours: 4.1 },
  { week: "2026-06-08", canonical_type: "cycling", count: 1, hours: 2.3 },
  { week: "2026-06-15", canonical_type: "running", count: 3, hours: 3.7 },
  { week: "2026-06-15", canonical_type: "strength", count: 2, hours: 2.0 },
];

const emptyDistribution = {
  model: "karvonen-five-zone",
  activityScope: "endurance",
  totalSeconds: 0,
  zones: [],
  explanation: "Observed intensity distribution.",
} satisfies TrainingHrZonesResult["intensityDistribution"];

const emptyHrZones: TrainingHrZonesResult = {
  maxHr: null,
  weeks: [],
  intensityDistribution: emptyDistribution,
};

const hrZones: TrainingHrZonesResult = {
  maxHr: 190,
  weeks: [
    {
      max_hr: 190,
      week: "2026-06-01",
      zone0: 1200,
      zone1: 3600,
      zone2: 7200,
      zone3: 800,
      zone4: 900,
      zone5: 0,
    },
    {
      max_hr: 190,
      week: "2026-06-08",
      zone0: 900,
      zone1: 4100,
      zone2: 8100,
      zone3: 700,
      zone4: 1100,
      zone5: 0,
    },
    {
      max_hr: 190,
      week: "2026-06-15",
      zone0: 1400,
      zone1: 3800,
      zone2: 7600,
      zone3: 900,
      zone4: 800,
      zone5: 0,
    },
  ],
  intensityDistribution: {
    ...emptyDistribution,
    totalSeconds: 43100,
    zones: [
      { zone: 0, label: "Below Zone 1", seconds: 3500, percent: 8.1 },
      { zone: 1, label: "Recovery", seconds: 11500, percent: 26.7 },
      { zone: 2, label: "Aerobic", seconds: 22900, percent: 53.1 },
      { zone: 3, label: "Tempo", seconds: 2400, percent: 5.6 },
      { zone: 4, label: "Threshold", seconds: 2800, percent: 6.5 },
      { zone: 5, label: "VO2max", seconds: 0, percent: 0 },
    ],
  },
};

function createMockLink(scenario: TrainingInsightsScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (scenario.loading) return createLoadingObservable();
      return createMockObservable(
        op.path === "training.weeklyVolume" ? scenario.volume : scenario.hrZones,
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

function TrainingInsightsStory({
  scenario,
  days,
}: {
  scenario: TrainingInsightsScenario;
  days: ComponentProps<typeof TrainingInsightsPanel>["days"];
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-full max-w-[900px] rounded-xl border border-border bg-surface p-5">
          <TrainingInsightsPanel days={days} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Training/TrainingInsightsPanel",
  component: TrainingInsightsPanel,
  tags: ["autodocs"],
  args: {
    days: 30,
  },
} satisfies Meta<typeof TrainingInsightsPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

const emptyScenario: TrainingInsightsScenario = {
  volume: [],
  hrZones: emptyHrZones,
};

export const Default: Story = {
  render: (args) => <TrainingInsightsStory scenario={{ volume, hrZones }} days={args.days} />,
};

export const VolumeOnly: Story = {
  render: (args) => (
    <TrainingInsightsStory scenario={{ volume, hrZones: emptyHrZones }} days={args.days} />
  ),
};

export const Loading: Story = {
  render: (args) => (
    <TrainingInsightsStory scenario={{ ...emptyScenario, loading: true }} days={args.days} />
  ),
};

export const Empty: Story = {
  render: (args) => <TrainingInsightsStory scenario={emptyScenario} days={args.days} />,
};
