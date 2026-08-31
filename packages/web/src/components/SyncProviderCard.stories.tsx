import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { SyncProviderCard } from "./SyncProviderCard.tsx";

function withRouter(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Story />,
  });
  const providerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "providers/$id",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([homeRoute, providerRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <div className="w-screen max-w-sm p-6 bg-background">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Providers/SyncProviderCard",
  component: SyncProviderCard,
  tags: ["autodocs"],
  decorators: [withRouter],
  args: {
    provider: {
      id: "strava",
      name: "Strava",
      lastSyncedAt: "2026-05-12T10:00:00.000Z",
      lastSuccessfulSyncAt: "2026-05-12T10:00:00.000Z",
      syncFreshness: {
        status: "current",
        label: "Sync current",
        description: "The last successful sync completed within the expected cadence.",
      },
      authorized: true,
      description: null,
    },
    state: { status: "idle" },
    needsAuth: false,
    needsReauth: false,
    stats: undefined,
    recentLogs: [
      {
        id: "strava-sync-1",
        syncedAt: "2026-05-12T10:00:00.000Z",
        status: "success",
        dataType: "activities",
        recordCount: 12,
        durationMs: 1200,
        errorMessage: null,
        authFailureReason: null,
      },
    ],
    onSync: () => {},
  },
} satisfies Meta<typeof SyncProviderCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Syncing: Story = {
  args: {
    state: { status: "syncing", message: "Syncing activities...", percentage: 45 },
  },
};

export const NoSyncHistory: Story = {
  args: {
    recentLogs: [],
    provider: {
      id: "strava",
      name: "Strava",
      lastSyncedAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: {
        status: "unknown",
        label: "Sync status unknown",
        description: "No successful sync has been recorded.",
      },
      authorized: true,
      description: null,
    },
  },
};

export const OverdueProvider: Story = {
  name: "Overdue provider",
  tags: ["review-scenario", "review-scenario-stale-provider"],
  args: {
    provider: {
      id: "strava",
      name: "Strava",
      lastSyncedAt: "2026-08-12T12:00:00.000Z",
      lastSuccessfulSyncAt: "2026-08-11T12:00:00.000Z",
      syncFreshness: {
        status: "overdue",
        label: "Sync overdue",
        description: "The last successful sync is overdue.",
      },
      authorized: true,
      description: null,
    },
  },
};

export const NeedsAuth: Story = {
  args: {
    provider: {
      id: "oura",
      name: "Oura",
      lastSyncedAt: null,
      lastSuccessfulSyncAt: null,
      syncFreshness: null,
      authorized: false,
      description: null,
    },
    needsAuth: true,
    recentLogs: [],
  },
};

export const NeedsReauth: Story = {
  args: {
    provider: {
      id: "whoop",
      name: "WHOOP",
      lastSyncedAt: "2026-05-10T10:00:00.000Z",
      lastSuccessfulSyncAt: "2026-05-10T10:00:00.000Z",
      syncFreshness: {
        status: "overdue",
        label: "Sync overdue",
        description: "The last successful sync is overdue.",
      },
      authorized: true,
      description: null,
    },
    needsReauth: true,
  },
};
