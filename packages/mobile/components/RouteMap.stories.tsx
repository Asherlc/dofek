import type { Meta, StoryObj } from "@storybook/react-native";
import { areaClimbingLocation, exactClimbingLocation } from "./climbing-log-entry-fixtures";
import { RouteMap } from "./RouteMap";

const meta = {
  title: "Activity/RouteMap",
  component: RouteMap,
} satisfies Meta<typeof RouteMap>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A short loop through Central Park. */
export const Default: Story = {
  args: {
    points: [
      { lat: 40.7829, lng: -73.9654 },
      { lat: 40.7831, lng: -73.964 },
      { lat: 40.784, lng: -73.9628 },
      { lat: 40.7855, lng: -73.9615 },
      { lat: 40.787, lng: -73.9605 },
      { lat: 40.7878, lng: -73.961 },
      { lat: 40.7872, lng: -73.9632 },
      { lat: 40.786, lng: -73.9648 },
      { lat: 40.7845, lng: -73.9658 },
      { lat: 40.7829, lng: -73.9654 },
    ],
  },
};

/** A straight out-and-back route with no loop. */
export const OutAndBack: Story = {
  args: {
    points: [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.776, lng: -122.418 },
      { lat: 37.778, lng: -122.416 },
      { lat: 37.78, lng: -122.414 },
      { lat: 37.778, lng: -122.416 },
      { lat: 37.776, lng: -122.418 },
      { lat: 37.7749, lng: -122.4194 },
    ],
  },
};

/** Some points missing GPS coordinates (should be filtered out). */
export const SparseGps: Story = {
  args: {
    points: [
      { lat: 51.5074, lng: -0.1278 },
      { lat: null, lng: null },
      { lat: 51.509, lng: -0.126 },
      { lat: null, lng: null },
      { lat: 51.511, lng: -0.124 },
      { lat: 51.513, lng: -0.122 },
    ],
  },
};

/** No GPS data at all — component should render nothing. */
export const NoGpsData: Story = {
  args: {
    points: [],
  },
};

const sourceDots = [
  { entryId: "tick-1", label: "Swiss Cheese", location: exactClimbingLocation },
  { entryId: "tick-2", label: "Left Arete", location: areaClimbingLocation },
];
export const PointsOnly: Story = { args: { points: [], climbMarkers: sourceDots } };
export const RoutePlusDots: Story = {
  args: {
    points: [
      { lat: 37.227, lng: -122.097 },
      { lat: 37.2285, lng: -122.094 },
      { lat: 37.231, lng: -122.091 },
    ],
    climbMarkers: sourceDots,
  },
};
export const SingleClimb: Story = {
  args: { points: [], climbMarkers: sourceDots.slice(0, 1), compact: true },
};
export const AreaLocation: Story = {
  args: { points: [], climbMarkers: sourceDots.slice(1), compact: true },
};
export const RepeatedPoint: Story = {
  args: {
    points: [],
    climbMarkers: [
      { entryId: "tick-1", label: "Swiss Cheese", location: exactClimbingLocation },
      { entryId: "tick-4", label: "Swiss Cheese", location: exactClimbingLocation },
    ],
  },
};
