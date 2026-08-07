import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ComponentProps, useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { TrainingInsightsPanel } from "./TrainingInsightsPanel.tsx";

interface TrainingInsightsScenario {
  volume: unknown[];
  hrZones: {
    maxHr: number | null;
    weeks: unknown[];
  };
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

const hrZones = {
  maxHr: 190,
  weeks: [
    {
      week: "2026-06-01",
      zone0: 1200,
      zone1: 3600,
      zone2: 7200,
      zone3: 800,
      zone4: 900,
      zone5: 300,
    },
    {
      week: "2026-06-08",
      zone0: 900,
      zone1: 4100,
      zone2: 8100,
      zone3: 700,
      zone4: 1100,
      zone5: 450,
    },
    {
      week: "2026-06-15",
      zone0: 1400,
      zone1: 3800,
      zone2: 7600,
      zone3: 900,
      zone4: 800,
      zone5: 250,
    },
  ],
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
        <div className="w-[900px] rounded-xl border border-border bg-surface p-5">
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
  hrZones: { maxHr: null, weeks: [] },
};

export const Default: Story = {
  render: (args) => <TrainingInsightsStory scenario={{ volume, hrZones }} days={args.days} />,
};

export const VolumeOnly: Story = {
  render: (args) => (
    <TrainingInsightsStory
      scenario={{ volume, hrZones: { maxHr: null, weeks: [] } }}
      days={args.days}
    />
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
