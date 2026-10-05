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
import { trpc } from "../../lib/trpc.ts";
import { ClimbingTab } from "./climbing.tsx";

const mockLink: TRPCLink<AppRouter> =
  () =>
  ({ op }) => {
    const grade = { climbType: "route", gradeSystem: "yds", grade: "5.10a", gradeSortValue: 10 };
    const data =
      op.path === "climbing.gradeProgression"
        ? [{ ...grade, date: "2026-10-04" }]
        : op.path === "climbing.volumeByGrade"
          ? [{ ...grade, attempts: 3, sends: 2 }]
          : op.path === "climbing.sessionSummary"
            ? [
                {
                  activityId: "demo",
                  date: "2026-10-04",
                  name: "Afternoon climbing",
                  locationName: "Crag",
                  attempts: 3,
                  sends: 2,
                  hardestBoulderGrade: null,
                  hardestBoulderGradeSortValue: null,
                  hardestRouteGrade: "5.10a",
                  hardestRouteGradeSortValue: 10,
                },
              ]
            : op.path === "activity.list"
              ? { items: [], totalCount: 0 }
              : op.path === "climbing.hangboardingSummary"
                ? {
                    sessionCount: 0,
                    totalDurationSeconds: 0,
                    averageDurationSeconds: null,
                    totalWorkDurationSeconds: null,
                    totalRestDurationSeconds: null,
                    workIntervalCount: null,
                    averageHeartRate: null,
                    peakHeartRate: null,
                    latestSession: null,
                    daily: [],
                  }
                : null;
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
  };
function Preview() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const client = useMemo(() => trpc.createClient({ links: [mockLink] }), []);
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: "/", component: ClimbingTab });
    const activityRoute = createRoute({
      getParentRoute: () => root,
      path: "activity/$id",
      component: () => <div>Activity details preview</div>,
    });
    return createRouter({
      routeTree: root.addChildren([route, activityRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, []);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="max-w-5xl bg-background p-4">
          <RouterProvider router={router} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: "Training/Climbing",
  component: Preview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
