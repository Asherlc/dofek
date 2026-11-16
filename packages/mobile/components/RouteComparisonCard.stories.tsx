import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { RouteComparisonCard } from "./RouteComparisonCard";
import { routeComparisonFixture } from "./route-comparison-fixtures";

type Scenario = "default" | "loading" | "empty" | "refreshing";
function Preview({ scenario }: { scenario: Scenario }) {
  const { client, queryClient } = useMemo(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (scenario === "refreshing") {
      queryClient.setQueryData(
        getQueryKey(trpc.hiking.activityComparison, { days: 90 }, "query"),
        routeComparisonFixture,
      );
    }
    const link: TRPCLink<AppRouter> =
      () =>
      ({ op }) => {
        const result: OperationResultObservable<AppRouter, unknown> = {
          subscribe(observer) {
            if (
              op.path === "hiking.activityComparison" &&
              ["loading", "refreshing"].includes(scenario)
            )
              return { unsubscribe() {} };
            const data =
              op.path === "settings.get"
                ? { value: "metric" }
                : scenario === "empty"
                  ? []
                  : routeComparisonFixture;
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
          <RouteComparisonCard days={90} enabled />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: "Training/RouteComparisonCard",
  component: RouteComparisonCard,
  args: { days: 90, enabled: true },
  render: () => <Preview scenario="default" />,
} satisfies Meta<typeof RouteComparisonCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { render: () => <Preview scenario="loading" /> };
export const Empty: Story = { render: () => <Preview scenario="empty" /> };
export const Refreshing: Story = { render: () => <Preview scenario="refreshing" /> };
