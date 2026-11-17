import { sportVolumeMetricSchema, sportVolumeMetrics } from "@dofek/training/sport-volume";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { z } from "zod";
import { trpc } from "../lib/trpc";
import { SportVolumeChart } from "./SportVolumeChart";

const weeks = [
  { week: "2026-10-05", value: 90 },
  { week: "2026-10-12", value: 120 },
];
type Scenario = "default" | "loading" | "empty" | "refreshing";
function Preview({ scenario }: { scenario: Scenario }) {
  const { client, queryClient } = useMemo(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const volume = {
      sport: "running",
      sports: ["running", "cycling"],
      metric: "time",
      unit: "min",
      metrics: sportVolumeMetrics("running"),
      weeks,
    };
    if (scenario === "refreshing") {
      queryClient.setQueryData(
        getQueryKey(trpc.training.sportVolume, { days: 90, metric: "time" }, "query"),
        volume,
      );
    }
    const link: TRPCLink<AppRouter> =
      () =>
      ({ op }) => {
        const result: OperationResultObservable<AppRouter, unknown> = {
          subscribe(observer) {
            if (op.path === "training.sportVolume" && ["loading", "refreshing"].includes(scenario))
              return { unsubscribe() {} };
            const input =
              op.path === "training.sportVolume"
                ? z
                    .object({ sport: z.string().optional(), metric: sportVolumeMetricSchema })
                    .parse(op.input)
                : null;
            const sport = input?.sport ?? "running";
            const metrics = sportVolumeMetrics(sport);
            const data = input
              ? {
                  ...volume,
                  sport,
                  metrics,
                  metric: input.metric,
                  unit: metrics.find((entry) => entry.key === input.metric)?.unit,
                  weeks: scenario === "empty" ? [] : weeks,
                }
              : { value: "metric" };
            observer.next?.({ result: { data } });
            observer.complete?.();
            return { unsubscribe() {} };
          },
          pipe() {
            return result;
          },
        };
        return result;
      };
    return { queryClient, client: trpc.createClient({ links: [link] }) };
  }, [scenario]);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 390, maxWidth: "100%" }}>
          <SportVolumeChart days={90} enabled />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: "Training/SportVolumeChart",
  component: SportVolumeChart,
  args: { days: 90, enabled: true },
  render: () => <Preview scenario="default" />,
} satisfies Meta<typeof SportVolumeChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { render: () => <Preview scenario="loading" /> };
export const Empty: Story = { render: () => <Preview scenario="empty" /> };
export const Refreshing: Story = { render: () => <Preview scenario="refreshing" /> };
