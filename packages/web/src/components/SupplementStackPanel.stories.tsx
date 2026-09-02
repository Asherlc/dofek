import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { SupplementStackPanel } from "./SupplementStackPanel.tsx";

interface SupplementScenario {
  supplements: unknown[];
  loading?: boolean;
}

const supplements = [
  {
    id: "definition-creatine",
    name: "Creatine monohydrate",
    amount: 5,
    unit: "g",
    form: "powder",
    meal: "breakfast",
  },
  {
    id: "definition-vitamin-d3",
    name: "Vitamin D3",
    amount: 50,
    unit: "mcg",
    form: "softgel",
    meal: "breakfast",
    vitaminDMcg: 50,
  },
  {
    id: "definition-magnesium",
    name: "Magnesium glycinate",
    amount: 300,
    unit: "mg",
    form: "capsule",
    meal: "dinner",
    magnesiumMg: 300,
  },
];

function createMockLink(scenario: SupplementScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path === "supplements.list" && scenario.loading) return createLoadingObservable();
      return createMockObservable(
        op.path === "supplements.list" ? scenario.supplements : { ok: true },
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

function SupplementStory({ scenario }: { scenario: SupplementScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[720px] rounded-xl border border-border bg-surface p-5">
          <SupplementStackPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Nutrition/SupplementStackPanel",
  component: SupplementStackPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof SupplementStackPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <SupplementStory scenario={{ supplements }} />,
};

export const Loading: Story = {
  render: () => <SupplementStory scenario={{ supplements: [], loading: true }} />,
};

export const Empty: Story = {
  render: () => <SupplementStory scenario={{ supplements: [] }} />,
};
