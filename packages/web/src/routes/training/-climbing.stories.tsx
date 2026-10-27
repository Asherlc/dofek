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
import { expect, within } from "storybook/test";
import { z } from "zod";
import "leaflet/dist/leaflet.css";
import { climbingLocationMapFixture } from "../../components/climbing-location-map-test-helpers.ts";
import { climbingAttachmentActivities } from "../../components/climbing-log-attachment-test-helpers.ts";
import { climbingProgressionFixture } from "../../components/climbing-progression-test-helpers.ts";
import { climbingStrengthsFixture } from "../../components/climbing-strengths-fixtures.ts";
import { trpc } from "../../lib/trpc.ts";
import { ClimbingTab } from "./climbing.tsx";

const mockLink: TRPCLink<AppRouter> = () => {
  let mapFixture = climbingLocationMapFixture;
  return ({ op }) => {
    if (op.path === "climbing.attachClimbingLogEntry") {
      const input = z
        .object({ climbingLogEntryId: z.string(), activityId: z.string() })
        .parse(op.input);
      mapFixture = {
        ...mapFixture,
        nodes: mapFixture.nodes.map((node) => ({
          ...node,
          entries: node.entries.map((entry) =>
            entry.id === input.climbingLogEntryId
              ? { ...entry, activityId: input.activityId }
              : entry,
          ),
        })),
      };
    }
    const grade = { climbKind: "route", gradeSystem: "yds", grade: "5.10a", gradeSortValue: 10 };
    const data =
      op.path === "climbing.strengths"
        ? climbingStrengthsFixture
        : op.path === "climbing.locationMap"
          ? mapFixture
          : op.path === "climbing.attachmentActivities"
            ? climbingAttachmentActivities
            : op.path === "climbing.attachClimbingLogEntry"
              ? { attached: true }
              : op.path === "climbing.gradeProgression"
                ? [climbingProgressionFixture("route", { ropeMethod: "lead" })]
                : op.path === "climbing.volumeOverTime"
                  ? [
                      { week: "2026-09-28", attempts: 12, minutes: 120 },
                      { week: "2026-10-05", attempts: 8, minutes: 90 },
                    ]
                  : op.path === "climbing.volumeByGrade"
                    ? [{ ...grade, attempts: 3, recordedAttempts: 3, sends: 2 }]
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
export const AttachClimbToActivity: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "3 climbs. Zoom in to explore." }),
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "2 climbs. Show climb details." }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Attach to activity for Left Arete" }),
    );
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Attach Left Arete to activity",
    });
    await userEvent.click(await within(dialog).findByRole("radio", { name: /Approach hike/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    await expect(
      canvas.findByRole("link", { name: "View activity for Left Arete" }),
    ).resolves.toHaveAttribute("href", "/activity/22222222-2222-4222-8222-222222222222");
  },
};
