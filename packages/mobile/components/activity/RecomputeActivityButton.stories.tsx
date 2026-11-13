import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../../lib/trpc";
import { RecomputeActivityButton } from "./RecomputeActivityButton";

type RecomputeStoryScenario = "running" | "completed" | "failed";
const recomputeScenarios: RecomputeStoryScenario[] = ["running", "completed", "failed"];

function recomputeScenario(value: unknown): RecomputeStoryScenario {
  return recomputeScenarios.find((scenario) => scenario === value) ?? "completed";
}

function createRecomputeMockLink(scenario: RecomputeStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path === "activity.recompute") {
            observer.next?.({
              result: { data: { success: true, analyticsJobId: "recompute-job-1" } },
            });
          } else if (op.path === "activity.recomputeStatus") {
            observer.next?.({
              result: {
                data: {
                  status: scenario === "running" ? "pending" : scenario,
                  error:
                    scenario === "failed"
                      ? "Recomputing this activity failed. Use Recompute to try again."
                      : null,
                },
              },
            });
          } else {
            observer.next?.({ result: { data: null } });
          }
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function RecomputeStoryProviders({
  children,
  scenario,
}: {
  children: ReactNode;
  scenario: RecomputeStoryScenario;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createRecomputeMockLink(scenario)] }),
    [scenario],
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Activity/RecomputeActivityButton",
  component: RecomputeActivityButton,
  args: { activityId: "00000000-0000-4000-8000-000000000401" },
  decorators: [
    (Story, context) => (
      <RecomputeStoryProviders scenario={recomputeScenario(context.parameters.recomputeScenario)}>
        <View style={{ padding: 16 }}>
          <Story />
        </View>
      </RecomputeStoryProviders>
    ),
  ],
} satisfies Meta<typeof RecomputeActivityButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Running: Story = {
  parameters: { recomputeScenario: "running" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Recompute activity" }));
    await canvas.findByText("Recomputing...");
  },
};
export const Completed: Story = {
  parameters: { recomputeScenario: "completed" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Recompute activity" }));
    await canvas.findByText("Recompute");
  },
};
export const Failed: Story = {
  parameters: { recomputeScenario: "failed" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Recompute activity" }));
    await canvas.findByText("Recompute");
  },
};
