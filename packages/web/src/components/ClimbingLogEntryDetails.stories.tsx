import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails.tsx";

const entry = climbingLogEntryFixture({
  climb: climbingClimbFixture(),
  climbedOn: "2026-10-01",
  reportedGrades: [{ value: "5.10b", system: "yds" }],
  notes: "A recorded note",
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
      <div className="max-w-xl rounded bg-surface p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingLogEntryDetails>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RecordedAidCompletion: Story = {};
export const CategoricalWallAndMultipleGrips: Story = {
  args: { entry: { ...entry, wallAngle: { category: "slab" }, holdTypes: ["crimp", "jug"] } },
};
export const UnknownAttemptCount: Story = {
  args: { entry: { ...entry, providerId: "mountain-project", recordedClimbAttemptCount: null } },
};
export const UnknownTotalWithKnownOrder: Story = {
  args: {
    entry: {
      ...entry,
      providerId: "mountain-project",
      recordedClimbAttemptCount: null,
      attempts: [climbingAttemptFixture(entry.id, { ropeMethod: "lead", attemptIndex: 1 })],
    },
  },
};
export const UnknownTarget: Story = {
  args: {
    entry: climbingLogEntryFixture({
      recordedClimbAttemptCount: 1,
      attempts: [climbingAttemptFixture(entry.id)],
    }),
  },
};
export const Empty: Story = { args: { entry: climbingLogEntryFixture() } };

export const GroupedSourceTags: Story = {
  args: {
    entry: {
      ...entry,
      holdTypes: ["crimp"],
      tags: [
        {
          providerId: "kaya",
          sourceKey: "grip",
          label: "Crimp",
          categoryKey: "3",
          categoryLabel: "Grip",
        },
        {
          providerId: "kaya",
          sourceKey: "unknown-grip",
          label: "Moon scoop",
          categoryKey: "3",
          categoryLabel: "Grip",
        },
        {
          providerId: "kaya",
          sourceKey: "move",
          label: "Bicycle",
          categoryKey: "2",
          categoryLabel: "Movement",
        },
        {
          providerId: "kaya",
          sourceKey: "custom",
          label: "Quiet movement",
          categoryKey: "custom",
          categoryLabel: "My category",
        },
        {
          providerId: "custom-source",
          sourceKey: "unknown",
          label: "Unclassified tag",
          categoryKey: null,
          categoryLabel: null,
        },
      ],
    },
  },
};
