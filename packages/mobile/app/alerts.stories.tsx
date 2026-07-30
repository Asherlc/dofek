import type { ProcessingAlert } from "@dofek/providers/processing-alerts";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import AlertsScreen from "./alerts";

type AlertsScenario =
  | "needs-attention"
  | "loading"
  | "all-clear"
  | "status-unavailable"
  | "stale-status";

function occurredMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const activeAlerts = [
  {
    id: "garmin-sync:activity",
    providerId: "garmin",
    providerLabel: "Garmin",
    datasetKey: "activity",
    occurredAt: occurredMinutesAgo(4),
    title: "Garmin activities weren’t updated",
    message:
      "Your Garmin data synced, but Dofek couldn’t update activities. Your previously synced data is still available.",
    action: "retry_sync",
    actionLabel: "Retry Garmin sync",
  },
  {
    id: "whoop-sync:recovery",
    providerId: "whoop",
    providerLabel: "WHOOP",
    datasetKey: "recovery",
    occurredAt: occurredMinutesAgo(18),
    title: "WHOOP couldn’t sync",
    message:
      "Dofek couldn’t get the latest data from WHOOP. Reconnect WHOOP, then start the sync again.",
    action: "reconnect",
    actionLabel: "Reconnect WHOOP",
  },
] satisfies ProcessingAlert[];

function createMockLink(scenario: AlertsScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op: operation }) =>
      createMockObservable(operation.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: AlertsScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "processing.alerts") {
        if (scenario === "loading") {
          return { unsubscribe: () => {} };
        }
        if (scenario === "status-unavailable" || scenario === "stale-status") {
          observer.error?.(
            TRPCClientError.from<AppRouter>(new Error("Alert status service timed out.")),
          );
          return { unsubscribe: () => {} };
        }
        observer.next?.({
          result: {
            data: {
              generatedAt: new Date().toISOString(),
              alerts: scenario === "all-clear" ? [] : activeAlerts,
            },
          },
        });
      } else if (path === "sync.triggerSync") {
        observer.next?.({
          result: {
            data: [
              {
                providerId: "garmin",
                status: "started",
                jobId: "storybook-sync",
                queueName: "provider-sync-garmin",
              },
            ],
          },
        });
      } else {
        observer.error?.(
          TRPCClientError.from<AppRouter>(new Error(`Unhandled Storybook tRPC operation: ${path}`)),
        );
        return { unsubscribe: () => {} };
      }
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function AlertsStoryFrame({ scenario }: { scenario: AlertsScenario }) {
  const queryClient = useMemo(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (scenario === "stale-status") {
      client.setQueryData(getQueryKey(trpc.processing.alerts, undefined, "query"), {
        generatedAt: occurredMinutesAgo(12),
        alerts: activeAlerts,
      });
    }
    return client;
  }, [scenario]);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <AlertsScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Alerts",
  component: AlertsScreen,
} satisfies Meta<typeof AlertsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  render: () => <AlertsStoryFrame scenario="needs-attention" />,
};

export const Loading: Story = {
  render: () => <AlertsStoryFrame scenario="loading" />,
};

export const AllClear: Story = {
  render: () => <AlertsStoryFrame scenario="all-clear" />,
};

export const StatusUnavailable: Story = {
  tags: ["review-scenario", "review-scenario-error"],
  render: () => <AlertsStoryFrame scenario="status-unavailable" />,
};

export const StaleAlerts: Story = {
  render: () => <AlertsStoryFrame scenario="stale-status" />,
};
