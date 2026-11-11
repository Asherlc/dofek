import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { VerticalAscentRow } from "dofek-server/types";
import { UnitContext } from "../lib/unitContext.ts";
import { VerticalAscentChart } from "./VerticalAscentChart.tsx";

const activities: VerticalAscentRow[] = [
  {
    activityId: "00000000-0000-4000-8000-000000000001",
    date: "2026-04-11",
    activityName: "Recovery Spin",
    activityType: "cycling",
    modality: "road",
    verticalAscentRate: 100,
    elevationGainMeters: 150,
    elapsedMinutes: 90,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000002",
    date: "2026-04-18",
    activityName: "Hill Country Tempo",
    activityType: "cycling",
    modality: "road",
    verticalAscentRate: 610,
    elevationGainMeters: 890,
    elapsedMinutes: 112,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000003",
    date: "2026-05-02",
    activityName: "Rocky Ridge",
    activityType: "mountain_biking",
    modality: "mountain",
    verticalAscentRate: 475,
    elevationGainMeters: 720,
    elapsedMinutes: 128,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000004",
    date: "2026-05-16",
    activityName: "Gravel Escarpment",
    activityType: "gravel_cycling",
    modality: "gravel",
    verticalAscentRate: 535,
    elevationGainMeters: 1_240,
    elapsedMinutes: 166,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000005",
    date: "2026-05-30",
    activityName: "Summit Repeats",
    activityType: "road_cycling",
    modality: "road",
    verticalAscentRate: 780,
    elevationGainMeters: 1_560,
    elapsedMinutes: 142,
  },
];

const meta = {
  title: "Training/VerticalAscentChart",
  component: VerticalAscentChart,
  tags: ["autodocs"],
  args: { data: activities },
  decorators: [
    (Story) => {
      const rootRoute = createRootRoute({ component: Outlet });
      const storyRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: Story,
      });
      const activityRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/activity/$id",
        component: () => <p>Activity detail: {activityRoute.useParams().id}</p>,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([storyRoute, activityRoute]),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });
      return (
        <div className="w-[760px] p-4">
          <RouterProvider router={router} />
        </div>
      );
    },
  ],
} satisfies Meta<typeof VerticalAscentChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const Imperial: Story = {
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
};
