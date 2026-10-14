import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";

const log = climbingLogEntryFixture({
  climb: climbingClimbFixture(),
  displayGrade: "5.10a",
  recordedClimbAttemptCount: 1,
});
log.attempts = [climbingAttemptFixture(log.id, { ropeMethod: "top_rope" })];
const meta = {
  title: "Climbing/Log Entry Breakdown",
  component: ClimbingLogEntryBreakdown,
  args: { entries: [log] },
} satisfies Meta<typeof ClimbingLogEntryBreakdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnknownExecution: Story = {};
