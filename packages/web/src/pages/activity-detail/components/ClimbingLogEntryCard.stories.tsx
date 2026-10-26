import type { Meta, StoryObj } from "@storybook/react-vite";
import "leaflet/dist/leaflet.css";
import {
  climbingAttemptFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
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
export const Completed: Story = {
  args: {
    location: undefined,
    entry: {
      ...meta.args.entry,
      freeSend: false,
      recordedClimbOutcome: "completed",
      recordedClimbAttemptCount: 2,
      attempts: [
        climbingAttemptFixture(meta.args.entry.id, { outcome: "failed" }),
        climbingAttemptFixture(meta.args.entry.id, { outcome: "completed", fellOrHung: true }),
      ],
    },
  },
};
export const Attempted: Story = {
  args: {
    location: undefined,
    entry: {
      ...meta.args.entry,
      freeSend: false,
      recordedClimbOutcome: "failed",
      recordedClimbAttemptCount: 1,
      attempts: [
        climbingAttemptFixture(meta.args.entry.id, {
          outcome: "failed",
          ropeMethod: "top_rope",
        }),
      ],
    },
  },
};
export const RouteWithTicks: Story = {
  args: {
    entry: {
      ...meta.args.entry,
      sourceLinks: [
        ...meta.args.entry.sourceLinks,
        {
          providerId: "mountain-project",
          kind: "ticks",
          url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
        },
      ],
    },
  },
};
export const Area: Story = { args: { location: areaClimbingLocation } };
export const NoGPS: Story = { args: { location: undefined } };
export const MinimalEntry: Story = {
  args: { entry: climbingLogEntryFixture(), location: undefined, entryNumber: undefined },
};
export const SelectedOccurrence: Story = { args: { entryNumber: 3, selected: true } };
