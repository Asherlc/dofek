import type { Meta, StoryObj } from "@storybook/react-vite";
import "leaflet/dist/leaflet.css";
import { ClimbingEntryCard } from "./ClimbingEntryCard.tsx";

const meta = {
  title: "Activity Detail/ClimbingEntryCard",
  component: ClimbingEntryCard,
  decorators: [
    (Story) => (
      <ul className="max-w-sm">
        <Story />
      </ul>
    ),
  ],
  args: {
    entryId: "tick-1",
    name: "Swiss Cheese",
    location: {
      coordinates: { latitude: 37.234, longitude: -122.111 },
      scope: "climb",
      objectId: "swiss-cheese",
      providerId: "mountain-project",
      name: "Swiss Cheese",
    },
    children: (
      <>
        <p className="font-medium">Swiss Cheese · 5.4</p>
        <p className="text-sm text-subtle">Top rope</p>
      </>
    ),
  },
} satisfies Meta<typeof ClimbingEntryCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Area: Story = {
  args: {
    location: { ...meta.args.location, scope: "area", name: "Goat Rock", objectId: "goat-rock" },
  },
};
export const NoGPS: Story = { args: { location: undefined } };
