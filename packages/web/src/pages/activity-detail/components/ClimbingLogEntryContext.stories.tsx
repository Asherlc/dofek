import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext.tsx";

const meta = {
  title: "Climbing/Log Entry Context",
  component: ClimbingLogEntryContext,
  args: { entry: climbingLogEntryFixture({ climb: climbingClimbFixture() }) },
} satisfies Meta<typeof ClimbingLogEntryContext>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentLocation: Story = {};
export const UnknownAngleUnits: Story = {
  args: {
    entry: climbingLogEntryFixture({
      board: { name: "Training Board", externalId: null },
      wallAngle: { value: -20, unit: null },
    }),
  },
};
export const ZeroDegrees: Story = {
  args: { entry: climbingLogEntryFixture({ wallAngle: { value: 0, unit: "degrees" } }) },
};
