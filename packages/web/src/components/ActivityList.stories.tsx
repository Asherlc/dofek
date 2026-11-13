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
import { expect, within } from "storybook/test";
import { UnitContext } from "../lib/unitContext.ts";
import { type Activity, ActivityList } from "./ActivityList.tsx";

const mapPreview = {
  width: 1024,
  height: 576,
  center: [-122.4188, 37.77525] satisfies [number, number],
  zoom: 18,
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
    primary_canonical_type: null,
    name: "Morning Run",
    provider_id: "strava",
    source_providers: ["strava"],
    distance_meters: 5000,
    distance_state: { status: "available" },
    elevation_gain_m: 120,
    elevation_state: { status: "available" },
    location: {
      kind: "recorded_gps",
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
    primary_canonical_type: null,
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

export const PrimarySourceWithoutTitle: Story = {
  args: {
    activities: activities.slice(0, 1).map((activity) => ({
      ...activity,
      name: null,
      canonical_type: "walking",
      primary_canonical_type: "running",
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Running")).toBeVisible();
    await expect(canvas.getByText("Walking")).toBeVisible();
  },
};

export const ProcessingMap: Story = {
  args: {
    activities: activities.map((activity) => ({ ...activity, location: { kind: "processing" } })),
  },
};

export const Climbing: Story = {
  args: {
    activities: [
      {
        id: "activity-climbing",
        started_at: "2026-10-04T17:00:00Z",
        ended_at: "2026-10-04T20:30:00Z",
        canonical_type: "climbing",
        primary_canonical_type: null,
        name: null,
        provider_id: "whoop",
        source_providers: ["apple_health", "whoop"],
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
        elevation_gain_m: null,
        elevation_state: { status: "missing", reason: "Elevation gain not recorded" },
      },
    ],
    showDistance: false,
    onBulkDelete: () => {},
    additionalColumns: [
      {
        key: "attempts",
        label: "Attempts",
        headerClassName: "pb-2 pr-4 whitespace-nowrap",
        cellClassName: "py-2 pr-4 text-muted tabular-nums whitespace-nowrap",
        renderCell: () => "—",
      },
      {
        key: "sends",
        label: "Sends",
        headerClassName: "pb-2 pr-4 whitespace-nowrap",
        cellClassName: "py-2 pr-4 text-muted tabular-nums whitespace-nowrap",
        renderCell: () => 1,
      },
      {
        key: "best-boulder-grade",
        label: "Best Boulder Grade",
        headerClassName: "pb-2 pr-4 whitespace-nowrap",
        cellClassName: "py-2 pr-4 text-muted whitespace-nowrap",
        renderCell: () => "VB",
      },
      {
        key: "best-route-grade",
        label: "Best Route Grade",
        headerClassName: "pb-2 whitespace-nowrap",
        cellClassName: "py-2 text-muted whitespace-nowrap",
        renderCell: () => "None",
      },
    ],
  },
};

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
