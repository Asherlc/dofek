import { sportVolumeMetricSchema, sportVolumeMetrics } from "@dofek/training/sport-volume";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { z } from "zod";
import { trpc } from "../lib/trpc.ts";
import { SportVolumeChart } from "./SportVolumeChart.tsx";

const link: TRPCLink<AppRouter> =
  () =>
  ({ op }) => {
    const input = z
      .object({ sport: z.string().optional(), metric: sportVolumeMetricSchema })
      .parse(op.input);
    const sport = input.sport ?? "running";
    const metrics = sportVolumeMetrics(sport);
    const data = {
      sport,
      sports: ["cycling", "running", "swimming", "yoga"],
      metric: input.metric,
      metrics,
      unit: metrics.find((entry) => entry.key === input.metric)?.unit ?? "min",
      weeks: [
        { week: "2026-10-05", value: 90 },
        { week: "2026-10-12", value: null },
        { week: "2026-10-19", value: 120 },
      ],
    };
    const result: OperationResultObservable<AppRouter, unknown> = {
      subscribe(observer) {
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
function Example() {
  const { queryClient, client } = useMemo(
    () => ({ queryClient: new QueryClient(), client: trpc.createClient({ links: [link] }) }),
    [],
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[800px] p-4">
          <SportVolumeChart days={30} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: "Training/SportVolumeChart",
  component: SportVolumeChart,
  args: { days: 30 },
  render: () => <Example />,
} satisfies Meta<typeof SportVolumeChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
