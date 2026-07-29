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
import { within } from "storybook/test";
import { UnitContext } from "../lib/unitContext.ts";
import { type Activity, ActivityList } from "./ActivityList.tsx";

const mapPreview = {
  width: 1024,
  height: 576,
  tiles: [
    {
      url: "https://tile.openstreetmap.org/19/83856/202646.png",
      x: -179.332,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202646.png",
      x: 76.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202646.png",
      x: 332.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202646.png",
      x: 588.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202646.png",
      x: 844.668,
      y: -132.862,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83856/202647.png",
      x: -179.332,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202647.png",
      x: 76.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202647.png",
      x: 332.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202647.png",
      x: 588.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202647.png",
      x: 844.668,
      y: 123.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83856/202648.png",
      x: -179.332,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83857/202648.png",
      x: 76.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83858/202648.png",
      x: 332.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83859/202648.png",
      x: 588.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
    {
      url: "https://tile.openstreetmap.org/19/83860/202648.png",
      x: 844.668,
      y: 379.138,
      width: 256,
      height: 256,
    },
  ],
  routePath: [
    { x: 288.304, y: 453.089 },
    { x: 512, y: 311.585 },
    { x: 735.696, y: 122.911 },
  ],
};

const activities: Activity[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    started_at: "2026-03-18T07:00:00Z",
    ended_at: "2026-03-18T07:45:00Z",
    canonical_type: "running",
    name: "Morning Run",
    provider_id: "strava",
    source_providers: ["strava"],
    distance_meters: 5000,
    distance_state: { status: "available" },
    elevation_gain_m: 120,
    elevation_state: { status: "available" },
    location: {
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview,
    },
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    started_at: "2026-03-17T17:00:00Z",
    ended_at: "2026-03-17T18:00:00Z",
    canonical_type: "cycling",
    name: "Trainer Ride",
    provider_id: "wahoo",
    source_providers: ["wahoo"],
    distance_meters: null,
    distance_state: { status: "missing", reason: "Distance not recorded" },
    elevation_gain_m: null,
    elevation_state: { status: "missing", reason: "Elevation gain not recorded" },
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

export const SelectionMode: Story = {
  args: {
    onBulkDelete: () => {},
  },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Select activities" }));
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

export const ScopedEmpty: Story = {
  args: {
    activities: [],
    emptyMessage:
      "No strength workouts in the selected 30-day range. Included types: strength, strength training, functional strength, and functional fitness.",
  },
};
