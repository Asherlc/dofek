import type { UnitSystem } from "@dofek/format/units";
import { STRENGTH_ACTIVITY_TYPES } from "@dofek/training/training";
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
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { RecentActivitiesSection } from "./RecentActivitiesSection.tsx";

interface ActivitiesScenario {
  items: unknown[];
  totalCount: number;
  state?: "ready" | "loading" | "error";
  unitSystem?: UnitSystem;
}

const activities = [
  {
    id: "activity-run",
    started_at: "2026-07-24T14:15:00.000Z",
    ended_at: "2026-07-24T15:02:00.000Z",
    activity_type: "running",
    name: "Morning tempo",
    provider_id: "garmin",
    source_providers: ["garmin"],
    distance_meters: 9200,
    distance_state: { status: "available" },
    location: null,
  },
  {
    id: "activity-strength",
    started_at: "2026-07-23T23:30:00.000Z",
    ended_at: "2026-07-24T00:35:00.000Z",
    activity_type: "strength_training",
    name: "Lower body",
    provider_id: "apple_health",
    source_providers: ["apple_health"],
    distance_meters: null,
    distance_state: { status: "missing", reason: "Distance not recorded" },
    location: null,
  },
];

function createMockLink(scenario: ActivitiesScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path !== "activity.list") return createMockObservable({ ok: true });
      if (scenario.state === "loading") return createLoadingObservable();
      if (scenario.state === "error") return createErrorObservable();
      return createMockObservable({ items: scenario.items, totalCount: scenario.totalCount });
    };
}

function createMockObservable(data: unknown): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function createLoadingObservable(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe() {
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function createErrorObservable(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.error?.(new TRPCClientError("Activities could not be loaded."));
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function ActivitiesStory({
  scenario,
  activityTypes,
  emptyMessage,
}: {
  scenario: ActivitiesScenario;
  activityTypes?: readonly string[];
  emptyMessage?: string;
}) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet });
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <RecentActivitiesSection activityTypes={activityTypes} emptyMessage={emptyMessage} />
      ),
    });
    const activityRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "activity/$id",
      component: () => null,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([homeRoute, activityRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, [activityTypes, emptyMessage]);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <UnitContext.Provider
          value={{ unitSystem: scenario.unitSystem ?? "metric", setUnitSystem: () => {} }}
        >
          <div className="w-[980px] bg-background p-5">
            <RouterProvider router={router} />
          </div>
        </UnitContext.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Activities/RecentActivitiesSection",
  component: RecentActivitiesSection,
  tags: ["autodocs"],
} satisfies Meta<typeof RecentActivitiesSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ActivitiesStory scenario={{ items: activities, totalCount: activities.length }} />,
};

export const Imperial: Story = {
  render: () => (
    <ActivitiesStory
      scenario={{ items: activities, totalCount: activities.length, unitSystem: "imperial" }}
    />
  ),
};

export const Loading: Story = {
  render: () => <ActivitiesStory scenario={{ items: [], totalCount: 0, state: "loading" }} />,
};

export const Empty: Story = {
  render: () => <ActivitiesStory scenario={{ items: [], totalCount: 0 }} />,
};

export const ScopedStrengthEmpty: Story = {
  render: () => (
    <ActivitiesStory
      scenario={{ items: [], totalCount: 0 }}
      activityTypes={STRENGTH_ACTIVITY_TYPES}
      emptyMessage="No strength workouts in the selected 30-day range. Included types: strength, strength training, functional strength, and functional fitness."
    />
  ),
};

export const ErrorState: Story = {
  name: "Error",
  render: () => <ActivitiesStory scenario={{ items: [], totalCount: 0, state: "error" }} />,
};
