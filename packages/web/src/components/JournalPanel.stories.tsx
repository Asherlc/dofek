import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { JournalPanel } from "./JournalPanel.tsx";

interface JournalScenario {
  entries: unknown[];
  loading?: boolean;
}

const entries = [
  {
    id: "journal-alcohol",
    date: "2026-07-24",
    provider_id: "whoop",
    question_slug: "alcohol",
    display_name: "Alcohol",
    category: "substance",
    data_type: "boolean",
    unit: null,
    answer_text: null,
    answer_numeric: 1,
    impact_score: 0.4,
  },
  {
    id: "journal-energy",
    date: "2026-07-24",
    provider_id: "dofek",
    question_slug: "energy",
    display_name: "Energy",
    category: "wellness",
    data_type: "numeric",
    unit: "/10",
    answer_text: null,
    answer_numeric: 8,
    impact_score: 1.4,
  },
  {
    id: "journal-training",
    date: "2026-07-24",
    provider_id: "dofek",
    question_slug: "strength_training",
    display_name: "Strength training",
    category: "activity",
    data_type: "boolean",
    unit: null,
    answer_text: null,
    answer_numeric: 1,
    impact_score: 0.8,
  },
  {
    id: "journal-note",
    date: "2026-07-23",
    provider_id: "apple_health",
    question_slug: "daily_note",
    display_name: "Daily note",
    category: "custom",
    data_type: "text",
    unit: null,
    answer_text: "Good focus after an easy morning.",
    answer_numeric: null,
    impact_score: null,
  },
];

const questions = [
  {
    slug: "energy",
    display_name: "Energy",
    category: "wellness",
    data_type: "numeric",
    unit: "/10",
    sort_order: 1,
  },
];

function createMockLink(scenario: JournalScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path === "journal.entries" && scenario.loading) return createLoadingObservable();
      if (op.path === "journal.entries") return createMockObservable(scenario.entries);
      if (op.path === "journal.questions") return createMockObservable(questions);
      return createMockObservable({ ok: true });
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

function JournalStory({ scenario }: { scenario: JournalScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[820px] rounded-xl border border-border bg-surface p-5">
          <JournalPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Tracking/JournalPanel",
  component: JournalPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof JournalPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <JournalStory scenario={{ entries }} />,
};

export const Loading: Story = {
  render: () => <JournalStory scenario={{ entries: [], loading: true }} />,
};

export const Empty: Story = {
  render: () => <JournalStory scenario={{ entries: [] }} />,
};
