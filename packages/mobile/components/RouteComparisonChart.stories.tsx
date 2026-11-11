import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { RouteComparisonChart } from "./RouteComparisonChart";
import { routeComparisonFixture } from "./route-comparison-fixtures";

const meta = {
  title: "Charts/RouteComparisonChart",
  component: RouteComparisonChart,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: "#f5f7f2", width: 390 }}>
        <Story />
      </View>
    ),
  ],
  args: {
    routes: routeComparisonFixture,
    units: new UnitConverter("metric"),
    onActivityPress: () => {},
  },
} satisfies Meta<typeof RouteComparisonChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultipleRoutes: Story = {};
export const MatchingRouteTitles: Story = {
  args: {
    routes: routeComparisonFixture.map((route) => ({
      ...route,
      activityName: "Running",
      activityType: "running",
      attemptCount: 3,
    })),
  },
};
export const SameDay: Story = {
  args: {
    routes: routeComparisonFixture.map((route) => ({
      ...route,
      instances: route.instances.slice(0, 2),
    })),
  },
};
export const MultipleYears: Story = {
  args: {
    routes: routeComparisonFixture.map((route) => ({
      ...route,
      instances: route.instances.map((instance, index) => ({
        ...instance,
        startedAt: index === 0 ? "2025-10-20T08:00:00.000Z" : instance.startedAt,
      })),
    })),
  },
};
export const Imperial: Story = { args: { units: new UnitConverter("imperial") } };
export const UnavailablePace: Story = {
  args: {
    routes: routeComparisonFixture.map((route) => ({
      ...route,
      instances: route.instances.map((instance) => ({ ...instance, averagePaceMinPerKm: null })),
    })),
  },
};
export const EqualPace: Story = {
  args: {
    routes: routeComparisonFixture.map((route) => ({
      ...route,
      instances: route.instances.map((instance) => ({ ...instance, averagePaceMinPerKm: 5 })),
    })),
  },
};
