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
  sourceLinks: [],
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
export const SwissCheese: Story = {
  args: {
    entries: [
      {
        ...entry,
        grade: "5.4",
        sent: null,
        attempts: [],
        holdType: null,
        routeName: "Swiss Cheese",
        sourceLinks: [
          {
            providerId: "mountain-project",
            kind: "route",
            url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
          },
        ],
        locationName:
          "California > San Francisco Bay Area > South Bay Area > Castle Rock and Sanborn Area > Goat Rock Area > Goat Rock",
        context: {
          ...entry.context,
          locationPath: [
            "California",
            "San Francisco Bay Area",
            "South Bay Area",
            "Castle Rock and Sanborn Area",
            "Goat Rock Area",
            "Goat Rock",
          ].map((name) => ({
            name,
            externalId: null,
            kind: null,
          })),
          resultStyle: null,
        },
      },
    ],
  },
};
export const Onsight: Story = {
  args: {
    entries: [
      {
        ...entry,
        grade: "5.6",
        sent: true,
        attempts: [],
        ascentType: "Onsight",
        holdType: null,
        routeName: "Left Arete",
        lead: true,
        context: { ...entry.context, climbStyle: "lead", resultStyle: "Onsight" },
      },
    ],
  },
};
export const Flash: Story = {
  args: {
    entries: [
      {
        ...entry,
        sent: true,
        attemptCount: 1,
        attempts: [],
        ascentType: "Flash",
        holdType: null,
        context: { ...entry.context, resultStyle: "Flash" },
      },
    ],
  },
};
export const Repeat: Story = {
  args: {
    entries: [
      {
        ...entry,
        sent: true,
        attempts: [],
        ascentType: "Repeat",
        holdType: null,
        context: { ...entry.context, resultStyle: "Repeat" },
      },
    ],
  },
};
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
        sourceLinks: [],
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
