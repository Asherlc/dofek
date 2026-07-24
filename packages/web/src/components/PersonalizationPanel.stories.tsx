import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { PersonalizationPanel } from "./PersonalizationPanel.tsx";

type PersonalizationScenario = "default" | "personalized";

const defaultStressThresholds = {
  hrvThresholds: [-2, -1.5, -1],
  rhrThresholds: [2, 1.5, 1],
};

const personalizedStressThresholds = {
  hrvThresholds: [-1.82, -1.27, -0.64],
  rhrThresholds: [1.91, 1.24, 0.58],
};

const defaultEffectiveParameters = {
  exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
  readinessWeights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
  sleepTarget: { minutes: 480 },
  stressThresholds: defaultStressThresholds,
  trainingImpulseConstants: { genderFactor: 0.64, exponent: 1.92 },
};

function personalizationStatus(scenario: PersonalizationScenario) {
  const stressThresholds =
    scenario === "personalized"
      ? {
          ...personalizedStressThresholds,
          sampleCount: 90,
        }
      : null;

  return {
    isPersonalized: stressThresholds !== null,
    fittedAt: stressThresholds === null ? null : "2026-07-20T08:00:00.000Z",
    defaults: defaultEffectiveParameters,
    effective: {
      ...defaultEffectiveParameters,
      stressThresholds: stressThresholds ?? defaultStressThresholds,
    },
    parameters: {
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds,
      trainingImpulseConstants: null,
    },
  };
}

function createMockLink(scenario: PersonalizationScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(
        op.path === "personalization.status" ? personalizationStatus(scenario) : null,
      );
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

function PersonalizationPanelStoryFrame({ scenario }: { scenario: PersonalizationScenario }) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[560px] p-4">
          <PersonalizationPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/PersonalizationPanel",
  component: PersonalizationPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof PersonalizationPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PersonalizationPanelStoryFrame scenario="default" />,
};

export const Personalized: Story = {
  render: () => <PersonalizationPanelStoryFrame scenario="personalized" />,
};
