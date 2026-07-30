import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { JournalPanel } from "./JournalPanel.tsx";
import {
  emptyJournalTrendEvidence,
  type JournalTrendEvidence,
} from "./journal-trend-test-fixtures.ts";

interface JournalScenario {
  entries: unknown[];
  loading?: boolean;
  trends?: JournalTrendEvidence;
}

const entries = [
  {
    id: "journal-alcohol",
    date: "2026-07-24",
    source: { providerId: "manual_review", label: "Manual review" },
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
    source: { providerId: "dofek", label: "Dofek" },
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
    source: { providerId: "dofek", label: "Dofek" },
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
    id: "journal-alcohol-no",
    date: "2026-07-23",
    provider_id: "whoop",
    question_slug: "alcohol",
    display_name: "Alcohol",
    category: "substance",
    data_type: "boolean",
    unit: null,
    answer_text: null,
    answer_numeric: 0,
    impact_score: -0.2,
  },
  {
    id: "journal-note",
    date: "2026-07-23",
    source: { providerId: "apple_health", label: "Apple Health" },
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
    slug: "alcohol",
    display_name: "Alcohol",
    category: "substance",
    data_type: "boolean",
    unit: null,
    sort_order: 1,
  },
  {
    slug: "energy",
    display_name: "Energy",
    category: "wellness",
    data_type: "numeric",
    unit: "/10",
    sort_order: 2,
  },
];

const trendEvidence: JournalTrendEvidence = {
  window: {
    startDate: "2026-07-21",
    endDate: "2026-07-24",
    dayCount: 4,
    gapRepresentation: "explicit_daily",
  },
  statement:
    "3 exact observations across 2 of 4 days. Missing days indicate no journal value was recorded.",
  uncertainty: {
    status: "unavailable",
    statement: "Uncertainty interval: not available for raw journal observations.",
  },
  series: [
    {
      questionSlug: "alcohol",
      displayName: "Alcohol",
      dataType: "boolean",
      unit: null,
      observationCount: 2,
      observedDayCount: 2,
      missingDayCount: 2,
      statement: "2 exact observations across 2 of 4 days; 2 days have no recorded value.",
      points: [
        { date: "2026-07-21", value: null, source: null },
        {
          date: "2026-07-22",
          value: 0,
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
        },
        { date: "2026-07-23", value: null, source: null },
        {
          date: "2026-07-24",
          value: 1,
          source: { providerId: "manual_review", label: "Manual review" },
        },
      ],
    },
    {
      questionSlug: "energy",
      displayName: "Energy",
      dataType: "numeric",
      unit: "/10",
      observationCount: 1,
      observedDayCount: 1,
      missingDayCount: 3,
      statement: "1 exact observation across 1 of 4 days; 3 days have no recorded value.",
      points: [
        { date: "2026-07-21", value: null, source: null },
        { date: "2026-07-22", value: null, source: null },
        { date: "2026-07-23", value: null, source: null },
        {
          date: "2026-07-24",
          value: 8,
          source: { providerId: "dofek", label: "Dofek" },
        },
      ],
    },
  ],
};

function createMockLink(scenario: JournalScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path === "journal.entries" && scenario.loading) return createLoadingObservable();
      if (op.path === "journal.entries") return createMockObservable(scenario.entries);
      if (op.path === "journal.questions") return createMockObservable(questions);
      if (op.path === "journal.trends") {
        return createMockObservable(scenario.trends ?? emptyJournalTrendEvidence);
      }
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

export const TrendEvidence: Story = {
  render: () => <JournalStory scenario={{ entries, trends: trendEvidence }} />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Trends" }));
  },
};
