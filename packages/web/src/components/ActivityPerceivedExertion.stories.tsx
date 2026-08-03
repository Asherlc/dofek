import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion.tsx";

type ActivityStoryScenario = "default" | "error" | "pending";

function createMockLink(scenario: ActivityStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path === "activity.setPerceivedExertion" && scenario === "pending") {
            return { unsubscribe: () => {} };
          }
          if (op.path === "activity.setPerceivedExertion" && scenario === "error") {
            observer.error?.(TRPCClientError.from(new Error("Session effort is unavailable.")));
            return { unsubscribe: () => {} };
          }
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

function ActivityStory({
  scenario,
  value,
}: {
  scenario: ActivityStoryScenario;
  value: number | null;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

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
  render: (args) => <ActivityStory scenario="default" value={args.value} />,
};

export const Logged: Story = {
  args: { activityId: "activity-story", value: 7 },
  render: (args) => <ActivityStory scenario="default" value={args.value} />,
};

export const Pending: Story = {
  args: { activityId: "activity-story", value: 7 },
  render: (args) => <ActivityStory scenario="pending" value={args.value} />,
  tags: ["review-scenario", "review-scenario-loading"],
};

export const ErrorState: Story = {
  args: { activityId: "activity-story", value: 7 },
  render: (args) => <ActivityStory scenario="error" value={args.value} />,
  tags: ["review-scenario", "review-scenario-error"],
};
