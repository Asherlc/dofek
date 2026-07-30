import type { ProcessingAlert } from "@dofek/providers/processing-alerts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { ProcessingAlertsProvider } from "../lib/processing-alerts-context.tsx";
import { trpc } from "../lib/trpc.ts";
import { AlertsPage } from "./AlertsPage.tsx";

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
  {
    id: "apple-health-import:sleep",
    providerId: "apple_health",
    providerLabel: "Apple Health",
    datasetKey: "sleep",
    occurredAt: occurredMinutesAgo(42),
    title: "Apple Health file wasn’t imported",
    message:
      "Dofek couldn’t finish importing the Apple Health file. Check that you selected the correct file, then import it again.",
    action: "retry_import",
    actionLabel: "Import Apple Health again",
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
  const router = useMemo(() => {
    const rootRoute = createRootRoute({
      component: () => (
        <ProcessingAlertsProvider>
          <AlertsPage />
        </ProcessingAlertsProvider>
      ),
    });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Alerts",
  component: AlertsPage,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AlertsPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  name: "Needs attention",
  render: () => <AlertsStoryFrame scenario="needs-attention" />,
};

export const Loading: Story = {
  render: () => <AlertsStoryFrame scenario="loading" />,
};

export const AllClear: Story = {
  name: "All clear",
  render: () => <AlertsStoryFrame scenario="all-clear" />,
};

export const StatusUnavailable: Story = {
  name: "Status unavailable",
  tags: ["review-scenario", "review-scenario-error"],
  render: () => <AlertsStoryFrame scenario="status-unavailable" />,
};

export const StaleAlerts: Story = {
  name: "Stale alerts after refresh failure",
  render: () => <AlertsStoryFrame scenario="stale-status" />,
};
