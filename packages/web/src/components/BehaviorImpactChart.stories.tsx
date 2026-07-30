import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import type { TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { BehaviorImpactChart } from "./BehaviorImpactChart.tsx";

type BehaviorImpactScenario = "default" | "empty" | "error" | "loading";

const impacts = [
  {
    questionSlug: "meditation",
    displayName: "Meditation",
    category: "mindfulness",
    impactPercent: 18.6,
    yesCount: 18,
    noCount: 24,
    sources: [{ providerId: "manual_review", label: "Manual review" }],
  },
  {
    questionSlug: "late-meal",
    displayName: "Late meal",
    category: "nutrition",
    impactPercent: -12.4,
    yesCount: 14,
    noCount: 28,
    sources: [
      { providerId: "manual_review", label: "Manual review" },
      { providerId: "whoop", label: "WHOOP (Cloud)" },
    ],
  },
  {
    questionSlug: "morning-sunlight",
    displayName: "Morning sunlight",
    category: "routine",
    impactPercent: 9.8,
    yesCount: 21,
    noCount: 17,
    sources: [{ providerId: "manual_review", label: "Manual review" }],
  },
  {
    questionSlug: "alcohol",
    displayName: "Alcohol",
    category: "substance",
    impactPercent: -24.1,
    yesCount: 9,
    noCount: 33,
    sources: [{ providerId: "whoop", label: "WHOOP (Cloud)" }],
  },
];

function createMockLink(scenario: BehaviorImpactScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: BehaviorImpactScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (scenario === "loading") return { unsubscribe: () => {} };
      if (scenario === "error") {
        observer.error?.(
          TRPCClientError.from(new Error("Behavior association data is unavailable.")),
        );
        return { unsubscribe: () => {} };
      }
      observer.next?.({
        result: {
          data: path === "behaviorImpact.impactSummary" && scenario === "default" ? impacts : [],
        },
      });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function BehaviorImpactStoryFrame({
  scenario,
  days = 90,
}: {
  scenario: BehaviorImpactScenario;
  days?: TimeRangeDays;
}) {
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
        <div className="w-full max-w-[760px] p-4">
          <BehaviorImpactChart days={days} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Recovery/BehaviorImpactChart",
  component: BehaviorImpactChart,
  tags: ["autodocs"],
  args: { days: 90 },
} satisfies Meta<typeof BehaviorImpactChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <BehaviorImpactStoryFrame scenario="default" days={args.days} />,
};
export const Loading: Story = {
  render: (args) => <BehaviorImpactStoryFrame scenario="loading" days={args.days} />,
};
export const Empty: Story = {
  render: (args) => <BehaviorImpactStoryFrame scenario="empty" days={args.days} />,
};
export const ErrorState: Story = {
  render: (args) => <BehaviorImpactStoryFrame scenario="error" days={args.days} />,
};

export const NarrowViewport: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  render: (args) => <BehaviorImpactStoryFrame scenario="default" days={args.days} />,
};
