import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { fn } from "storybook/test";
import {
  climbingAttemptFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryCard } from "./ClimbingLogEntryCard";
import {
  areaClimbingLocation,
  climbingLogFixture,
  exactClimbingLocation,
} from "./climbing-log-entry-fixtures";

const meta = {
  title: "Climbing/Log Entry Card",
  component: ClimbingLogEntryCard,
  args: { entry: climbingLogFixture },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 320 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ClimbingLogEntryCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Sent: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      freeSend: true,
      recordedClimbAttemptCount: 1,
      attempts: [
        climbingAttemptFixture(climbingLogFixture.id, {
          ropeMethod: "lead",
          rockResultLabels: ["sent"],
        }),
      ],
    },
  },
};
export const Completed: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      freeSend: false,
      recordedClimbOutcome: "completed",
      recordedClimbAttemptCount: 2,
      attempts: [
        climbingAttemptFixture(climbingLogFixture.id, { outcome: "failed" }),
        climbingAttemptFixture(climbingLogFixture.id, { outcome: "completed", fellOrHung: true }),
      ],
    },
  },
};
export const Attempted: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      freeSend: false,
      recordedClimbOutcome: "failed",
      recordedClimbAttemptCount: 1,
      attempts: [climbingAttemptFixture(climbingLogFixture.id, { outcome: "failed" })],
    },
  },
};
export const FellHung: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      freeSend: false,
      recordedClimbOutcome: null,
      recordedClimbAttemptCount: null,
      attempts: [
        climbingAttemptFixture(climbingLogFixture.id, {
          ropeMethod: "lead",
          fellOrHung: true,
          outcome: null,
        }),
      ],
    },
  },
};
export const Onsight: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      freeSend: true,
      recordedClimbAttemptCount: 1,
      attempts: [
        climbingAttemptFixture(climbingLogFixture.id, {
          outcome: "completed",
          ropeMethod: "lead",
          rockResultLabels: ["sent", "Onsight"],
        }),
      ],
    },
  },
};
export const MinimalEntry: Story = { args: { entry: climbingLogEntryFixture() } };
export const ExactClimb: Story = { args: { location: exactClimbingLocation } };
export const AreaLocation: Story = { args: { location: areaClimbingLocation } };
export const TopRope: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      recordedClimbOutcome: null,
      recordedClimbAttemptCount: null,
      attempts: [climbingAttemptFixture(climbingLogFixture.id, { ropeMethod: "top_rope" })],
    },
  },
};
export const LongName: Story = {
  args: {
    entry: {
      ...climbingLogFixture,
      climb: null,
      title:
        "A very long route name across the upper wall above the California coastal climbing area",
    },
    location: exactClimbingLocation,
  },
};
export const AttachPending: Story = {
  args: {
    location: exactClimbingLocation,
    onAttach: fn(),
    attachmentState: { pending: true, error: null },
  },
};
export const AttachError: Story = {
  args: {
    location: areaClimbingLocation,
    onAttach: fn(),
    attachmentState: {
      pending: false,
      error: "Refresh this activity and try attaching this entry again.",
    },
  },
};

export const SharedMapRow: Story = {
  args: {
    hideMap: true,
    entryNumber: 1,
    onSelect: fn(),
    onOpenEntry: fn(),
    location: exactClimbingLocation,
  },
};
