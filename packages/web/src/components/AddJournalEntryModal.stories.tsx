import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ComponentProps, useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { AddJournalEntryModal } from "./AddJournalEntryModal.tsx";

interface JournalModalScenario {
  questions: unknown[];
  loading?: boolean;
}

const questions = [
  {
    slug: "energy",
    display_name: "Energy",
    category: "wellness",
    data_type: "numeric",
    unit: "/10",
    sort_order: 1,
  },
  {
    slug: "alcohol",
    display_name: "Drank alcohol",
    category: "substance",
    data_type: "boolean",
    unit: null,
    sort_order: 2,
  },
  {
    slug: "notes",
    display_name: "Daily notes",
    category: "custom",
    data_type: "text",
    unit: null,
    sort_order: 3,
  },
];

function createMockLink(scenario: JournalModalScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path === "journal.questions" && scenario.loading) return createLoadingObservable();
      return createMockObservable(
        op.path === "journal.questions" ? scenario.questions : { ok: true },
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

function AddJournalEntryModalStory({
  scenario,
  ...modalProps
}: { scenario: JournalModalScenario } & ComponentProps<typeof AddJournalEntryModal>) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AddJournalEntryModal {...modalProps} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Tracking/AddJournalEntryModal",
  component: AddJournalEntryModal,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    isOpen: true,
    onClose: () => {},
    onSuccess: () => {},
  },
} satisfies Meta<typeof AddJournalEntryModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <AddJournalEntryModalStory scenario={{ questions }} {...args} />,
};

export const Loading: Story = {
  render: (args) => (
    <AddJournalEntryModalStory scenario={{ questions: [], loading: true }} {...args} />
  ),
};

export const Empty: Story = {
  render: (args) => <AddJournalEntryModalStory scenario={{ questions: [] }} {...args} />,
};
