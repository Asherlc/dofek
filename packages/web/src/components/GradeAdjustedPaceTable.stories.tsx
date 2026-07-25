import type { UnitSystem } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { GradeAdjustedPaceRow } from "dofek-server/types";
import { UnitContext } from "../lib/unitContext.ts";
import { GradeAdjustedPaceTable } from "./GradeAdjustedPaceTable.tsx";

const data: GradeAdjustedPaceRow[] = [
  {
    activityId: "activity-1",
    date: "2026-03-18",
    activityName: "Ridge Trail Hike",
    activityType: "hiking",
    distanceKm: 12.4,
    durationMinutes: 168,
    averagePaceMinPerKm: 13.55,
    gradeAdjustedPaceMinPerKm: 10.9,
    elevationGainMeters: 820,
    elevationLossMeters: 815,
  },
  {
    activityId: "activity-2",
    date: "2026-03-11",
    activityName: "Neighborhood Walk",
    activityType: "walking",
    distanceKm: 5.2,
    durationMinutes: 61,
    averagePaceMinPerKm: 11.73,
    gradeAdjustedPaceMinPerKm: 11.4,
    elevationGainMeters: 54,
    elevationLossMeters: 51,
  },
];

function StoryFrame({
  unitSystem = "metric",
  rows = data,
  loading = false,
}: {
  unitSystem?: UnitSystem;
  rows?: GradeAdjustedPaceRow[];
  loading?: boolean;
}) {
  const rootRoute = createRootRoute({ component: Outlet });
  const storyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <GradeAdjustedPaceTable data={rows} loading={loading} />,
  });
  const activityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "activity/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([storyRoute, activityRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      <div className="w-[900px] bg-page p-6">
        <RouterProvider router={router} />
      </div>
    </UnitContext.Provider>
  );
}

const meta = {
  title: "Hiking/GradeAdjustedPaceTable",
  component: GradeAdjustedPaceTable,
  tags: ["autodocs"],
  args: {
    data,
  },
} satisfies Meta<typeof GradeAdjustedPaceTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StoryFrame />,
};

export const Imperial: Story = {
  render: () => <StoryFrame unitSystem="imperial" />,
};

export const Loading: Story = {
  render: () => <StoryFrame rows={[]} loading />,
};

export const Empty: Story = {
  render: () => <StoryFrame rows={[]} />,
};
