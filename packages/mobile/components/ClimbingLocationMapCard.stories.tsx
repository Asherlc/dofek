import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingLocationMapCard } from "./ClimbingLocationMapCard";
import { climbingLocationMapFixture } from "./climbing-location-map-fixtures";

const meta = {
  title: "Training/ClimbingLocationMapCard",
  component: ClimbingLocationMapCard,
  parameters: {
    docs: {
      description: {
        component:
          "The map reserves its viewport while the native renderer starts, showing the shared processing panel followed by the native loading indicator.",
      },
    },
  },
} satisfies Meta<typeof ClimbingLocationMapCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClusteredLocations: Story = { args: { data: climbingLocationMapFixture } };

export const IndividualClimbsAndRepeats: Story = {
  args: {
    data: {
      ...climbingLocationMapFixture,
      bounds: { south: 37.5, west: -122.5, north: 37.52, east: -122.48 },
    },
  },
};

export const Loading: Story = { args: { data: undefined, loading: true } };
export const CachedRefresh: Story = {
  args: { data: climbingLocationMapFixture, loading: true },
};
export const Empty: Story = { args: { data: { bounds: null, nodes: [] } } };
export const ErrorState: Story = {
  args: {
    data: undefined,
    error: { message: "Climbing locations could not be loaded. Try again." },
  },
};
export const CachedRefreshError: Story = {
  args: {
    data: climbingLocationMapFixture,
    loading: true,
    error: { message: "Climbing locations could not be refreshed. Try again." },
  },
};
