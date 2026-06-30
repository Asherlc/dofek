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

type DataSourcesScenario = "default" | "blocked" | "providersLoading" | "empty";

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

const blockedDataHealth = {
  overallStatus: "blocked",
  generatedAt: "2026-06-30T08:00:00.000Z",
  datasets: [
    {
      key: "activity",
      label: "Activities",
      rawRows: 120,
      latestRawAt: "2026-06-30T07:00:00.000Z",
      latestReadModelAt: null,
      cdcLagSeconds: null,
      readModelLagSeconds: null,
      status: "blocked",
      message: "Activities are synced, but activity summaries need attention.",
    },
  ],
};

const healthyDataHealth = {
  overallStatus: "healthy",
  generatedAt: "2026-06-30T08:00:00.000Z",
  datasets: [],
};

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
      } else if (path === "sync.dataHealth") {
        observer.next?.({
          result: { data: scenario === "blocked" ? blockedDataHealth : healthyDataHealth },
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
    component: () => <DataSourcesPanel />,
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

export const BlockedReadiness: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="blocked" />,
};

export const Loading: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="providersLoading" />,
};

export const Empty: Story = {
  render: () => <DataSourcesPanelStoryFrame scenario="empty" />,
};
