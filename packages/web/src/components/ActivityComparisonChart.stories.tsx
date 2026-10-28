import type { RouteComparison } from "@dofek/training/route-comparison";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { UnitContext } from "../lib/unitContext.ts";
import { ActivityComparisonChart } from "./ActivityComparisonChart.tsx";

function fixtureId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function routeFixture(index: number, activityName: string, distanceKm: number): RouteComparison {
  return {
    routeId: fixtureId(index),
    activityName,
    activityType: "hiking",
    attemptCount: 6,
    instances: [
      ["2020-06-08T15:30:00Z", 14.8],
      ["2021-03-13T16:15:00Z", 13.6],
      ["2022-08-20T14:00:00Z", 15.1],
      ["2024-09-07T14:30:00Z", 12.9],
      ["2026-02-28T16:00:00Z", 13.2],
      ["2026-10-10T15:00:00Z", 12.6],
    ].map(([startedAt, pace], attemptIndex) => ({
      activityId: fixtureId(index * 100 + attemptIndex),
      activityName: attemptIndex === 0 ? activityName : `${activityName} with friends`,
      startedAt: String(startedAt),
      date: String(startedAt).slice(0, 10),
      distanceKm,
      durationMinutes: Number(pace) * distanceKm,
      averagePaceMinPerKm: Number(pace),
      avgHeartRate: attemptIndex === 2 ? null : 125 + attemptIndex,
      elevationGainMeters: 486,
    })),
  };
}

const routes = [routeFixture(1, "Lakeside Loop", 8.4), routeFixture(2, "River Trail", 12.1)];
const crowdedRoutes = Array.from({ length: 24 }, (_, index) =>
  routeFixture(index + 1, index % 3 === 0 ? "Walking" : "Hiking", 3.6 + index * 0.7),
);
const sameDay: RouteComparison = {
  ...routeFixture(30, "Morning and evening ridge loops", 5.2),
  attemptCount: 4,
  instances: [
    "2026-10-10T14:00:00Z",
    "2026-10-10T15:30:00Z",
    "2026-10-10T22:00:00Z",
    "2026-10-10T23:30:00Z",
  ].map((startedAt, index) => ({
    activityId: fixtureId(3000 + index),
    activityName: index < 2 ? "Morning ridge loop" : "Evening ridge loop",
    startedAt,
    date: "2026-10-10",
    distanceKm: 5.2,
    durationMinutes: 64 + index * 2,
    averagePaceMinPerKm: 12.3 + index * 0.4,
    avgHeartRate: 128,
    elevationGainMeters: 200,
  })),
};
const missingPace: RouteComparison = {
  ...routeFixture(40, "Hiking", 7.2),
  instances: routeFixture(40, "Hiking", 7.2).instances.map((attempt, index) =>
    index % 2 === 0 ? { ...attempt, averagePaceMinPerKm: null, distanceKm: null } : attempt,
  ),
};

const meta = {
  title: "Hiking/ActivityComparisonChart",
  component: ActivityComparisonChart,
  tags: ["autodocs"],
  args: { data: routes },
  decorators: [
    (Story) => (
      <div className="w-full max-w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityComparisonChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const CrowdedHistory: Story = { args: { data: crowdedRoutes } };
export const SameDayAttempts: Story = { args: { data: [sameDay] } };
export const MissingPace: Story = { args: { data: [missingPace, ...routes] } };
export const NoPace: Story = {
  args: {
    data: [
      {
        ...missingPace,
        instances: missingPace.instances.map((attempt) => ({
          ...attempt,
          averagePaceMinPerKm: null,
        })),
      },
    ],
  },
};
export const LongRouteNames: Story = {
  args: {
    data: [
      routeFixture(
        50,
        "Mountain Ridge — Forest Loop, Steep Ravine, Valley Path and Coastal Trail via Ocean Beach",
        12.8,
      ),
      ...routes,
    ],
  },
};
export const Narrow: Story = {
  args: { data: crowdedRoutes },
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const Imperial: Story = {
  args: { data: crowdedRoutes },
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
};
