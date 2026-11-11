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
import { type ComponentType, useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner.tsx";

type RestoreScenario = "visible" | "pending" | "error" | "refreshing" | "refresh-error";

function createRestoreMockLink(scenario: RestoreScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path === "activity.restoreStatus") {
            observer.next?.({
              result: {
                data: {
                  status: scenario === "refresh-error" ? "failed" : "pending",
                  error:
                    scenario === "refresh-error"
                      ? "Activity restored, but refreshing charts failed. Use Recompute to retry."
                      : null,
                },
              },
            });
            observer.complete?.();
            return { unsubscribe: () => {} };
          }
          if (op.path !== "activity.restoreProviderAbsent") {
            throw new globalThis.Error(
              `Unhandled activity detail story tRPC operation: ${op.path}`,
            );
          }
          if (scenario === "pending") return { unsubscribe: () => {} };
          if (scenario === "error")
            observer.error?.(
              TRPCClientError.from(new globalThis.Error("Provider connection is unavailable")),
            );
          else {
            observer.next?.({
              result: {
                data: {
                  success: true,
                  restoredCount: 1,
                  analyticsJobId:
                    scenario === "refreshing" || scenario === "refresh-error"
                      ? "restore-job-1"
                      : null,
                  analyticsError: null,
                },
              },
            });
            observer.complete?.();
          }
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function StoryFrame({ Story, scenario }: { Story: ComponentType; scenario: RestoreScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createRestoreMockLink(scenario)] }),
    [scenario],
  );
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet });
    const bannerRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <Story />,
    });
    const providerRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/providers/$id",
      component: () => null,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([bannerRoute, providerRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, [Story]);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[560px] bg-page p-6">
          <RouterProvider router={router} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Activities/ProviderAbsentBanner",
  component: ProviderAbsentBanner,
  args: {
    activity: {
      id: "00000000-0000-4000-8000-000000000301",
      providerId: "strava",
      subsource: null,
      providerAbsentAt: "2026-05-27T12:00:00Z",
    },
  },
  decorators: [
    (Story, context) => (
      <StoryFrame Story={Story} scenario={context.parameters.restoreScenario ?? "visible"} />
    ),
  ],
  tags: ["autodocs"],
} satisfies Meta<typeof ProviderAbsentBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story = {};
export const Pending: Story = {
  parameters: { restoreScenario: "pending" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByRole("button", { name: "Restoring…" });
  },
};
export const RestoreError: Story = {
  name: "Error",
  parameters: { restoreScenario: "error" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByText("Provider connection is unavailable");
  },
};

export const RefreshingCharts: Story = {
  parameters: { restoreScenario: "refreshing" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByRole("button", { name: "Restoring…" });
  },
};
export const ChartRefreshError: Story = {
  parameters: { restoreScenario: "refresh-error" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByText(
      "Activity restored, but refreshing charts failed. Use Recompute to retry.",
    );
  },
};
