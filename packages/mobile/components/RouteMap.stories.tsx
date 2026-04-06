import type { Meta, StoryObj } from "@storybook/react-native";
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
