import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ActivityVariabilityTable } from "./ActivityVariabilityTable.tsx";

const rows = [
  {
    activityId: "activity-1",
    date: "2026-06-12",
    activityName: "Tempo Ride",
    normalizedPower: 238,
    averagePower: 214,
    variabilityIndex: 1.112,
    intensityFactor: 0.91,
  },
  {
    activityId: "activity-2",
    date: "2026-06-08",
    activityName: "Endurance Loop",
    normalizedPower: 192,
    averagePower: 186,
    variabilityIndex: 1.032,
    intensityFactor: 0.74,
  },
];

function withRouter(Story: () => React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const storyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Story,
  });
  const activityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/activity/$id",
    component: Story,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([storyRoute, activityRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return <RouterProvider router={router} />;
}

const meta = {
  title: "Components/ActivityVariabilityTable",
  component: ActivityVariabilityTable,
  tags: ["autodocs"],
  args: {
    data: rows,
    totalCount: rows.length,
    offset: 0,
    limit: 20,
    onPageChange: () => {},
    loading: false,
    emptyReason: null,
  },
  decorators: [(Story) => <div style={{ width: 760 }}>{withRouter(Story)}</div>],
} satisfies Meta<typeof ActivityVariabilityTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};

export const NoThresholdPower: Story = {
  args: {
    data: [],
    totalCount: 0,
    emptyReason: "no_ftp_estimate",
  },
};

export const NoNormalizedPower: Story = {
  args: {
    data: [],
    totalCount: 0,
    emptyReason: "no_normalized_power",
  },
};

export const NoCyclingActivities: Story = {
  args: {
    data: [],
    totalCount: 0,
    emptyReason: "no_cycling_activities",
  },
};
