import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion";

type ActivityStoryScenario = "default" | "error" | "loading";

function createMockLink(scenario: ActivityStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (scenario === "loading") return { unsubscribe: () => {} };
          if (scenario === "error") {
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

function ActivityStoryFrame({
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
        <View style={{ width: 360, padding: 16 }}>
          <ActivityPerceivedExertion activityId="activity-story" value={value} />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Activity/ActivityPerceivedExertion",
  component: ActivityPerceivedExertion,
} satisfies Meta<typeof ActivityPerceivedExertion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unset: Story = {
  render: () => <ActivityStoryFrame scenario="default" value={null} />,
};

export const Logged: Story = {
  render: () => <ActivityStoryFrame scenario="default" value={7} />,
};

export const Pending: Story = {
  render: () => <ActivityStoryFrame scenario="loading" value={7} />,
  tags: ["review-scenario", "review-scenario-loading"],
};

export const ErrorState: Story = {
  render: () => <ActivityStoryFrame scenario="error" value={7} />,
  tags: ["review-scenario", "review-scenario-error"],
};
