import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { AddJournalEntryModal } from "./AddJournalEntryModal.tsx";

const questions = [
  {
    slug: "energy",
    display_name: "Energy",
    category: "wellbeing",
    data_type: "numeric",
    unit: null,
    sort_order: 1,
  },
  {
    slug: "notes",
    display_name: "Notes",
    category: "wellbeing",
    data_type: "text",
    unit: null,
    sort_order: 2,
  },
];

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path === "journal.questions" ? questions : { ok: true });
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

function StoryFrame() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AddJournalEntryModal isOpen onClose={() => {}} onSuccess={() => {}} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Journal/AddJournalEntryModal",
  component: AddJournalEntryModal,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AddJournalEntryModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { isOpen: true, onClose: () => {}, onSuccess: () => {} },
  render: () => <StoryFrame />,
};
