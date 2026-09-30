import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ClimbingActivityEntryRow } from "../../../../../server/src/contracts/climbing-context-contracts.ts";
import { ClimbingEntryBreakdown } from "./ClimbingEntryBreakdown.tsx";

const entry: ClimbingActivityEntryRow = {
  id: "entry-1",
  climbType: "route",
  gradeSystem: "yds",
  grade: "5.10a",
  sent: false,
  attemptCount: null,
  attempts: [{ attemptIndex: 1, outcome: "failed", failureReason: "fell", notes: null }],
  ascentType: null,
  holdType: "crimp",
  routeName: "Corner",
  locationName: "Country > State > Region > Park > Crag > Wall",
  lead: false,
  sourceName: "Mountain Project",
  wallAngleDegrees: null,
  context: {
    providerId: "mountain-project",
    locationPath: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
      name,
      externalId: null,
      kind: null,
    })),
    board: null,
    wallAngle: null,
    climbStyle: "top-rope",
    resultStyle: "Fell/Hung",
  },
};

const meta = {
  title: "Activity Detail/ClimbingEntryBreakdown",
  component: ClimbingEntryBreakdown,
  args: { entries: [entry] },
} satisfies Meta<typeof ClimbingEntryBreakdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Outdoor: Story = {};
export const Board: Story = {
  args: {
    entries: [
      {
        ...entry,
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        attemptCount: 2,
        ascentType: "Redpoint",
        lead: null,
        sourceName: "Kaya",
        context: {
          ...entry.context,
          providerId: "kaya",
          board: { name: "Training Board", externalId: "board-1" },
          wallAngle: { value: -20, unit: null },
          climbStyle: null,
          resultStyle: "Redpoint",
        },
      },
    ],
  },
};
