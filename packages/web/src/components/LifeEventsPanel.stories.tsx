import type { UnitSystem } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { LifeEventsPanel } from "./LifeEventsPanel.tsx";

interface LifeEventStoryScenario {
  loading?: boolean;
  unitSystem?: UnitSystem;
  events: Array<{
    id: string;
    label: string;
    started_at: string;
    ended_at: string | null;
    category: string | null;
    ongoing: boolean;
    notes: string | null;
  }>;
  analysis: {
    event: LifeEventStoryScenario["events"][number];
    metrics: Array<Record<string, number | string>>;
    sleep: Array<Record<string, number | string>>;
    bodyComp: Array<Record<string, number | string>>;
  } | null;
}

const creatineEvent = {
  id: "event-creatine",
  label: "Started creatine",
  started_at: "2026-02-01",
  ended_at: null,
  category: "supplement",
  ongoing: true,
  notes: "5 g daily",
};

const travelWeekEvent = {
  id: "event-travel-week",
  label: "Travel Week",
  started_at: "2026-07-20",
  ended_at: "2026-07-27",
  category: "lifestyle",
  ongoing: false,
  notes: null,
};

const defaultScenario: LifeEventStoryScenario = {
  events: [
    creatineEvent,
    {
      id: "event-training",
      label: "Marathon block",
      started_at: "2026-01-05",
      ended_at: "2026-03-01",
      category: "training",
      ongoing: false,
      notes: null,
    },
  ],
  analysis: {
    event: creatineEvent,
    metrics: [
      { period: "before", days: 30, avg_resting_hr: 58, avg_hrv: 62, avg_steps: 9500 },
      { period: "after", days: 30, avg_resting_hr: 57, avg_hrv: 64, avg_steps: 10100 },
    ],
    sleep: [
      { period: "before", nights: 29, avg_sleep_min: 430, avg_deep_min: 72 },
      { period: "after", nights: 30, avg_sleep_min: 445, avg_deep_min: 80 },
    ],
    bodyComp: [
      { period: "before", measurements: 6, avg_weight: 80, avg_body_fat: 21.4 },
      { period: "after", measurements: 7, avg_weight: 79.5, avg_body_fat: 20.8 },
    ],
  },
};

const travelWeekScenario: LifeEventStoryScenario = {
  events: [travelWeekEvent],
  analysis: null,
};

const loadingScenario: LifeEventStoryScenario = {
  loading: true,
  events: [],
  analysis: null,
};

const emptyScenario: LifeEventStoryScenario = {
  events: [],
  analysis: null,
};

function createMockLink(scenario: LifeEventStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (scenario.loading && op.path === "lifeEvents.list") {
        return createPendingMockObservable();
      }
      return createMockObservable(resolveOperation(op.path, scenario));
    };
}

function createPendingMockObservable(): OperationResultObservable<AppRouter, unknown> {
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

function resolveOperation(path: string, scenario: LifeEventStoryScenario): unknown {
  switch (path) {
    case "lifeEvents.list":
      return scenario.events;
    case "lifeEvents.analyze":
      return scenario.analysis;
    case "lifeEvents.create":
    case "lifeEvents.delete":
      return { ok: true };
    default:
      return null;
  }
}

function LifeEventsStoryFrame({ scenario }: { scenario: LifeEventStoryScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <UnitContext.Provider
          value={{ unitSystem: scenario.unitSystem ?? "metric", setUnitSystem: () => {} }}
        >
          <div className="w-full max-w-[760px] p-2 sm:p-4">
            <LifeEventsPanel />
          </div>
        </UnitContext.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Body/LifeEventsPanel",
  component: LifeEventsPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof LifeEventsPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <LifeEventsStoryFrame scenario={defaultScenario} />,
};

export const Imperial: Story = {
  render: () => <LifeEventsStoryFrame scenario={{ ...defaultScenario, unitSystem: "imperial" }} />,
};

export const Empty: Story = {
  render: () => <LifeEventsStoryFrame scenario={emptyScenario} />,
};

export const Loading: Story = {
  render: () => <LifeEventsStoryFrame scenario={loadingScenario} />,
};

export const TravelWeek: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  render: () => <LifeEventsStoryFrame scenario={travelWeekScenario} />,
};

export const MobileAnalysis: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  render: () => <LifeEventsStoryFrame scenario={defaultScenario} />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: /Started creatine/i }),
    );
  },
};
