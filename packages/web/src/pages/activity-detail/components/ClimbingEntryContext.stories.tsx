import type { ClimbingContext } from "@dofek/training/climbing-context";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingEntryContext } from "./ClimbingEntryContext.tsx";

const empty: ClimbingContext = {
  providerId: "kaya",
  locationPath: [],
  board: null,
  wallAngle: null,
  climbStyle: null,
  resultStyle: null,
};
const meta = {
  title: "Climbing/Entry Context",
  component: ClimbingEntryContext,
  args: { context: empty, sent: null },
} satisfies Meta<typeof ClimbingEntryContext>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Gym: Story = {
  args: {
    context: {
      ...empty,
      locationPath: [{ name: "Test Gym", externalId: "gym-1", kind: "gym" }],
      resultStyle: "Flash",
    },
    sent: true,
  },
};
export const Outdoor: Story = {
  args: {
    context: {
      ...empty,
      providerId: "mountain-project",
      locationPath: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
        name,
        externalId: null,
        kind: null,
      })),
      climbStyle: "lead",
      resultStyle: "Redpoint",
    },
    sent: true,
  },
};
export const Board: Story = {
  args: {
    context: {
      ...empty,
      board: { name: "Training Board", externalId: "board-1" },
      wallAngle: { value: -20, unit: null },
      resultStyle: "Attempt",
    },
    sent: false,
  },
};
export const TopRopeUnknown: Story = {
  args: { context: { ...empty, providerId: "openbeta", climbStyle: "top-rope" } },
};
export const FellHung: Story = {
  args: {
    context: {
      ...empty,
      providerId: "mountain-project",
      climbStyle: "lead",
      resultStyle: "Fell/Hung",
    },
    sent: false,
  },
};
export const MissingMetadata: Story = {};
