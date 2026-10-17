import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ActivityMapTile } from "./ActivityMapTile";

const meta = {
  title: "Activity/ActivityMapTile",
  component: ActivityMapTile,
  decorators: [
    (Story) => (
      <View style={{ width: 360, maxWidth: "100%" }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivityMapTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Processing: Story = {
  args: { location: { kind: "processing" } },
};

export const RecordedRoute: Story = {
  args: {
    location: {
      kind: "recorded_gps",
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview: {
        width: 256,
        height: 256,
        tiles: [
          {
            url: "https://tile.openstreetmap.org/12/655/1583.png",
            x: 0,
            y: 0,
            width: 256,
            height: 256,
          },
        ],
        routePath: [
          { x: 70, y: 190 },
          { x: 110, y: 130 },
          { x: 190, y: 70 },
        ],
      },
    },
  },
};
