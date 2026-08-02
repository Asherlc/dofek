import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion.tsx";

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          observer.next?.({ result: { data: { perceivedExertion: 7 } } });
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      void op;
      return result;
    };
}

function ActivityStory({ value }: { value: number | null }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[640px] rounded-xl border border-border bg-surface p-5">
          <ActivityPerceivedExertion activityId="activity-story" value={value} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Activity/ActivityPerceivedExertion",
  component: ActivityPerceivedExertion,
  tags: ["autodocs"],
} satisfies Meta<typeof ActivityPerceivedExertion>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Unset: Story = {
  args: { activityId: "activity-story", value: null },
  render: (args) => <ActivityStory value={args.value} />,
};

export const Logged: Story = {
  args: { activityId: "activity-story", value: 7 },
  render: (args) => <ActivityStory value={args.value} />,
};
