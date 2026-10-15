import type { Meta, StoryObj } from "@storybook/react-vite";
import "leaflet/dist/leaflet.css";
import { climbingLogEntryFixture } from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryCard } from "./ClimbingLogEntryCard.tsx";
import {
  areaClimbingLocation,
  climbingMapLogs,
  exactClimbingLocation,
} from "./climbing-log-map-test-helpers.ts";

const meta = {
  title: "Climbing/Log Entry Card",
  component: ClimbingLogEntryCard,
  decorators: [
    (Story) => (
      <ul className="max-w-sm">
        <Story />
      </ul>
    ),
  ],
  args: {
    entry: climbingMapLogs[0] ?? climbingLogEntryFixture(),
    location: exactClimbingLocation,
    entryNumber: 1,
  },
} satisfies Meta<typeof ClimbingLogEntryCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Area: Story = { args: { location: areaClimbingLocation } };
export const NoGPS: Story = { args: { location: undefined } };
export const SelectedOccurrence: Story = { args: { entryNumber: 3, selected: true } };
