import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { DataSourcesPanel } from "./DataSourcesPanel.tsx";
import { PageSection } from "./PageSection.tsx";

type DataSourcesScenario = "default" | "providersLoading" | "empty" | "processingBlocked";

const providers = [
  {
    id: "garmin",
    name: "Garmin",
    description: "Wearable activity, sleep, and body data.",
    authType: "custom:garmin",
    authorized: true,
    lastSyncedAt: "2026-06-30T07:00:00.000Z",
    importOnly: false,
    pushOnly: false,
    needsReauth: false,
  },
  {
    id: "strava",
    name: "Strava",
    description: "Cycling and running activities.",
    authType: "oauth",
    authorized: false,
    lastSyncedAt: null,
    importOnly: false,
    pushOnly: false,
    needsReauth: false,
  },
];

function createMockLink(scenario: DataSourcesScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: DataSourcesScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "sync.providers") {
        if (scenario === "providersLoading") return { unsubscribe: () => {} };
        observer.next?.({ result: { data: scenario === "empty" ? [] : providers } });
      } else if (
        path === "sync.providerStats" ||
        path === "sync.logs" ||
        path === "sync.activeSyncs"
      ) {
        observer.next?.({ result: { data: [] } });
      } else if (path === "processing.status") {
        observer.next?.({
          result: {
            data:
              scenario === "processingBlocked"
                ? {
                    generatedAt: "2026-06-30T08:00:00.000Z",
                    scope: { providerId: null, datasets: ["providers"] },
                    overallStatus: "blocked",
                    operations: [],
                    datasets: [
                      {
                        key: "providers",
                        label: "Provider data",
                        status: "blocked",
                        currentStage: "cdc",
                        progressPercentage: null,
                        lastAdvancedAt: "2026-06-29T08:00:00.000Z",
                        lastReadyAt: null,
                      },
                    ],
                  }
                : {
                    generatedAt: "2026-06-30T08:00:00.000Z",
                    scope: { providerId: null, datasets: ["providers"] },
                    overallStatus: "ready",
                    operations: [],
                    datasets: [],
                  },
          },
        });
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

function createStoryRouter() {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const panelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <PageSection title="Data Sources" subtitle="Connect and manage health data providers">
        <DataSourcesPanel />
      </PageSection>
    ),
  });
  const providerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "providers/$id",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([panelRoute, providerRoute]);

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function DataSourcesPanelStoryFrame({ scenario }: { scenario: DataSourcesScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );
  const router = useMemo(createStoryRouter, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[900px] bg-background p-6">
          <RouterProvider router={router} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Providers/DataSourcesPanel",
  component: DataSourcesPanel,
} satisfies Meta<typeof DataSourcesPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="default" />,
};

export const Loading: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="providersLoading" />,
};

export const Empty: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="empty" />,
};

export const ProcessingBlocked: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="processingBlocked" />,
};
