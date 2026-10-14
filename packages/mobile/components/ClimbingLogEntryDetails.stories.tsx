import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails";

const entry = climbingLogEntryFixture({
  climb: climbingClimbFixture(),
  reportedGrades: [{ value: "5.10b", system: "yds" }],
  notes: "A recorded note",
  raw: { source: "Upstream record" },
  recordedClimbAttemptCount: 1,
  recordedClimbOutcome: "completed",
});
entry.climbId = entry.climb?.id ?? null;
entry.attempts = [
  climbingAttemptFixture(entry.id, {
    ropeMethod: "lead",
    solo: true,
    usedAid: true,
    outcome: "completed",
  }),
];
const meta = {
  title: "Components/ClimbingLogEntryDetails",
  component: ClimbingLogEntryDetails,
  args: { entry },
  decorators: [
    (Story) => (
      <View style={{ width: 360, padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ClimbingLogEntryDetails>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RecordedAidCompletion: Story = {};
export const UnknownTarget: Story = {
  args: {
    entry: climbingLogEntryFixture({
      recordedClimbAttemptCount: 1,
      attempts: [climbingAttemptFixture(entry.id)],
    }),
  },
};
