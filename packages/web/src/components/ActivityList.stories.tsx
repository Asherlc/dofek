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
import { UnitContext } from "../lib/unitContext.ts";
import { type Activity, ActivityList } from "./ActivityList.tsx";

const activities: Activity[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    started_at: "2026-03-18T07:00:00Z",
    ended_at: "2026-03-18T07:45:00Z",
    activity_type: "running",
    name: "Morning Run",
    provider_id: "strava",
    source_providers: ["strava"],
    distance_meters: 5000,
    calories: 450,
    location: {
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
      routePath: [
        { x: 25, y: 30 },
        { x: 35, y: 40 },
      ],
      distanceMeters: 5000,
      elevationGainM: 120,
    },
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    started_at: "2026-03-17T17:00:00Z",
    ended_at: "2026-03-17T18:00:00Z",
    activity_type: "indoor_cycling",
    name: "Trainer Ride",
    provider_id: "wahoo",
    source_providers: ["wahoo"],
    distance_meters: null,
    calories: 520,
  },
];

function withProviders(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Story />,
  });
  const activityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "activity/$id",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([homeRoute, activityRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
      <div className="w-[920px] bg-background p-6">
        <RouterProvider router={router} />
      </div>
    </UnitContext.Provider>
  );
}

const meta = {
  title: "Activities/ActivityList",
  component: ActivityList,
  tags: ["autodocs"],
  decorators: [withProviders],
  args: {
    activities,
  },
} satisfies Meta<typeof ActivityList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Selectable: Story = {
  args: {
    onBulkDelete: () => {},
  },
};

export const Loading: Story = {
  args: {
    activities: [],
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    activities: [],
  },
};
