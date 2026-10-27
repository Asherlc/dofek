import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { SleepSourceReview, type SleepSourceReviewNight } from "./SleepSourceReview";

const conflictingNight: SleepSourceReviewNight = {
  date: "2026-07-24",
  durationMinutes: 452,
  providerId: "whoop",
  sourceName: "WHOOP 4.0",
  sourceProviders: ["apple_health", "whoop"],
  selectedSessionId: "00000000-0000-4000-8000-000000001774",
  startedAt: "2026-07-25T05:55:00Z",
  endedAt: "2026-07-25T13:27:00Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  overlappingSessions: [
    {
      sessionId: "00000000-0000-4000-8000-000000001775",
      providerId: "oura",
      sourceName: "Oura Ring",
      sourceProviders: ["oura"],
      startedAt: "2026-07-25T07:20:00Z",
      endedAt: "2026-07-25T12:50:00Z",
      localTimeContext: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "provider_timezone",
      },
      durationMinutes: 330,
    },
  ],
};

const meta = {
  title: "Sleep/SleepSourceReview",
  component: SleepSourceReview,
  args: { nights: [conflictingNight] },
  decorators: [(Story) => <View style={{ width: 360, padding: 16 }}>{Story()}</View>],
} satisfies Meta<typeof SleepSourceReview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConflictingSources: Story = {
  tags: ["review-scenario", "review-scenario-conflicting-sources"],
};

export const NoConflict: Story = {
  args: {
    nights: [
      {
        ...conflictingNight,
        sourceProviders: ["whoop"],
        overlappingSessions: [],
      },
    ],
  },
};
