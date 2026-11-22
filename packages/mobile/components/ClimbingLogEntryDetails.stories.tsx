import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
  climbingProjectHistoryFixture,
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
export const ProjectInProgress: Story = {
  args: { projectHistory: { data: climbingProjectHistoryFixture() } },
};

export const FirstRecordedSend: Story = {
  args: {
    projectHistory: {
      data: climbingProjectHistoryFixture({
        sessionCount: 4,
        unsuccessfulSessionCount: 2,
        unknownSessionCount: 0,
        firstSend: { date: "2026-11-09", sessionCount: 2, method: "top_rope" },
        methodFirstSend: { date: "2026-11-17", sessionCount: 3, method: "lead" },
        days: [
          { date: "2026-11-04", outcome: "unsuccessful", method: "lead" },
          { date: "2026-11-09", outcome: "send", method: "top_rope" },
          { date: "2026-11-12", outcome: "unsuccessful", method: "lead" },
          { date: "2026-11-17", outcome: "send", method: "lead" },
        ],
      }),
    },
  },
};
export const HistoryLoading: Story = {
  args: { projectHistory: { isLoading: true } },
};

export const HistoryUnavailable: Story = {
  args: { projectHistory: { data: null } },
};

export const HistoryError: Story = {
  args: { projectHistory: { error: { message: "Project history is temporarily unavailable." } } },
};

export const CachedHistoryWithError: Story = {
  args: {
    projectHistory: {
      data: climbingProjectHistoryFixture(),
      error: { message: "Project history could not be refreshed." },
    },
  },
};

export const RepeatOnlyHistory: Story = {
  args: {
    projectHistory: {
      data: climbingProjectHistoryFixture({
        sessionCount: 1,
        unsuccessfulSessionCount: 0,
        unknownSessionCount: 0,
        firstSend: null,
        repeatBeforeFirstSend: true,
        days: [{ date: "2026-11-17", outcome: "send", method: null }],
      }),
    },
  },
};

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

export const UnorderedKayaAttempts: Story = {
  args: {
    entry: {
      ...entry,
      providerId: "kaya",
      sourceName: "Kaya",
      notes: null,
      recordedClimbAttemptCount: 2,
      attempts: [
        climbingAttemptFixture(entry.id, {
          ropeMethod: "top_rope",
          outcome: "completed",
          rockResultLabels: ["sent"],
          usedAid: false,
          fellOrHung: false,
        }),
        climbingAttemptFixture(entry.id, {
          id: "20000000-0000-4000-8000-000000000006",
          ropeMethod: "top_rope",
          outcome: "failed",
        }),
      ],
    },
  },
};

export const KilterBoardLocation: Story = {
  args: {
    entry: climbingLogEntryFixture({
      providerId: "kilter",
      sourceName: "Kilter Board",
      title: "Evening problem",
      climbedOn: "2026-11-09",
      board: { name: "Original 12 x 12", externalId: "wall-one" },
      wallAngle: { value: 40, unit: "degrees" },
      areaPath: [
        {
          id: "20000000-0000-4000-8000-000000000010",
          userId: entry.userId,
          providerId: "kilter",
          externalId: "gym-one",
          name: "Summit Climbing · North Gym",
          parentAreaId: null,
          coordinates: { latitude: 37.5, longitude: -122.25 },
        },
      ],
    }),
  },
};
