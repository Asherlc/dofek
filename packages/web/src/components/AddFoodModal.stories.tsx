import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { AddFoodModal } from "./AddFoodModal.tsx";

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path === "food.search" ? [] : null);
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

function StoryFrame({ submitting = false }: { submitting?: boolean }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AddFoodModal isOpen onClose={() => {}} onSubmit={() => {}} submitting={submitting} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Nutrition/AddFoodModal",
  component: AddFoodModal,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AddFoodModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { isOpen: true, onClose: () => {}, onSubmit: () => {} },
  render: () => <StoryFrame />,
};

export const Submitting: Story = {
  args: { isOpen: true, onClose: () => {}, onSubmit: () => {} },
  render: () => <StoryFrame submitting />,
};
