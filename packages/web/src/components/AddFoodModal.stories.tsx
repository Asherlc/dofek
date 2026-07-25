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
      createMockObservable(
        op.path === "food.analyzeWithAi"
          ? {
              nutrition: {
                foodName: "Greek yogurt with berries",
                foodDescription: "1 bowl",
                calories: 260,
                proteinG: 22,
                carbsG: 31,
                fatG: 6,
              },
            }
          : [],
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

function AddFoodModalStory(props: React.ComponentProps<typeof AddFoodModal>) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AddFoodModal {...props} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Nutrition/AddFoodModal",
  component: AddFoodModal,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    isOpen: true,
    onClose: () => {},
    onSubmit: () => {},
  },
  render: (args) => <AddFoodModalStory {...args} />,
} satisfies Meta<typeof AddFoodModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Lunch: Story = {
  args: {
    defaultMealType: "lunch",
  },
};

export const Submitting: Story = {
  args: {
    submitting: true,
  },
};
