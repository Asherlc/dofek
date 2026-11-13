import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { ScrollView } from "react-native";
import { fn } from "storybook/test";
import { ActivityClimbingPanel } from "./ActivityClimbingPanel";
import { CHART_COLORS, LineChart } from "./activity/ActivityDetailCharts";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";

const entries = [
  climbingLogFixture,
  { ...climbingLogFixture, id: "repeat" },
  { ...climbingLogFixture, id: "indoor", climb: null, title: "Indoor board log" },
];
const rootClimb = climbingLogFixture.climb;
if (!rootClimb) throw new Error("Expected climb fixture");
const rootArea = rootClimb.areaPath[0];
if (!rootArea) throw new Error("Expected area fixture");
const longAreaPath = [
  "California",
  "San Francisco Bay Area",
  "East Bay Area",
  "Berkeley",
  "Grizzly Peak Boulders",
  "Main Rock (aka Scary Boulder)",
].map((name, index) => ({
  ...rootArea,
  id: `long-area-${index}`,
  name,
  parentAreaId: index === 0 ? null : `long-area-${index - 1}`,
}));
const meta = {
  title: "Activity/Climbing layout",
  component: ActivityClimbingPanel,
  args: {
    entries,
    locations: { [climbingLogFixture.id]: exactClimbingLocation, repeat: exactClimbingLocation },
  },
  decorators: [
    (Story) => (
      <ScrollView style={{ maxWidth: 430 }} contentContainerStyle={{ padding: 16 }}>
        <Story />
      </ScrollView>
    ),
  ],
} satisfies Meta<typeof ActivityClimbingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BoardSesh: Story = {
  args: {
    entries: [
      {
        ...climbingLogFixture,
        providerId: "boardsesh",
        sourceName: "BoardSesh",
        externalId: "boardsesh:tick:tick-1",
        climb: {
          ...rootClimb,
          providerId: "boardsesh",
          name: "Moon Dust",
          kind: "boulder",
          areaPath: [],
        },
        attempts: climbingLogFixture.attempts.map((attempt) => ({ ...attempt, ropeMethod: null })),
        areaPath: [
          { ...rootArea, providerId: "boardsesh", name: "Movement Sunnyvale", coordinates: null },
        ],
        sourceLinks: [],
        displayGrade: "V5",
        board: { name: "Training Kilter", externalId: "board-42" },
        wallAngle: { value: 40, unit: "degrees" },
        chartAnnotations: [
          {
            id: climbingLogFixture.id,
            label: "Moon Dust · V5",
            startedAt: "2026-11-01T18:00:00Z",
            endedAt: null,
          },
        ],
      },
    ],
    locations: {},
  },
};
export const ExplicitLocationGroup: Story = {
  args: {
    locations: {},
    entries: ["Touchstone Great Western Power Company", "Great Western Power Company"].map(
      (name, index) => {
        const providerId = index === 0 ? "kaya" : "kilter";
        const area = { ...rootArea, id: `gym-${index}`, providerId, name };
        return {
          ...climbingLogFixture,
          id: `log-${index}`,
          providerId,
          sourceName: index === 0 ? "Kaya" : "Kilter Board",
          areaGroupId: "30000000-0000-4000-8000-000000000001",
          areaPath: [area],
          sourceLinks: [],
          climb: climbingLogFixture.climb
            ? { ...climbingLogFixture.climb, providerId, areaId: area.id, areaPath: [area] }
            : null,
        };
      },
    ),
  },
};
export const GroupedListAndMap: Story = {};
export const ApproximateArea: Story = {
  args: {
    locations: {
      [climbingLogFixture.id]: { ...exactClimbingLocation, scope: "area", name: "Goat Rock" },
      repeat: { ...exactClimbingLocation, scope: "area", name: "Goat Rock" },
    },
  },
};
export const LongAreaPath: Story = {
  args: {
    entries: [
      {
        ...climbingLogFixture,
        climb: climbingLogFixture.climb && {
          ...climbingLogFixture.climb,
          areaPath: longAreaPath,
        },
      },
    ],
    locations: { [climbingLogFixture.id]: exactClimbingLocation },
  },
};
export const Empty: Story = { args: { entries: [], locations: {} } };
export const NoLocations: Story = { args: { locations: {} } };

export const WithHeartRateChart: Story = {
  render: function Render(args) {
    const [highlightedClimbId, setHighlightedClimbId] = useState<string | null>(null);
    return (
      <>
        <LineChart
          data={Array.from({ length: 61 }, (_, index) => ({
            recordedAt: new Date(Date.UTC(2026, 9, 18, 17, 30, index * 5)).toISOString(),
            value: Math.round(110 + 30 * Math.sin(index / 8)),
          }))}
          color={CHART_COLORS.heartRate}
          label="Heart Rate"
          unit="bpm"
          highlightedClimbId={highlightedClimbId}
          onSelectClimb={setHighlightedClimbId}
          climbAnnotations={args.entries
            .filter((_, index) => index !== 2)
            .map((entry, index) => ({
              id: entry.id,
              label: entry.title ?? entry.climb?.name ?? "Climb",
              startedAt: new Date(Date.UTC(2026, 9, 18, 17, 31 + index)).toISOString(),
              endedAt: index === 1 ? "2026-10-18T17:32:40Z" : null,
            }))}
        />
        <ActivityClimbingPanel
          {...args}
          selectedEntryId={highlightedClimbId}
          onSelectEntry={setHighlightedClimbId}
        />
      </>
    );
  },
};

export const WithAttachmentSuggestions: Story = {
  args: {
    suggestions: [{ ...climbingLogFixture, id: "suggestion" }],
    locations: { ...meta.args.locations, suggestion: exactClimbingLocation },
    onAttach: fn(),
    attachmentStates: {
      suggestion: {
        pending: false,
        error: "Refresh this activity and try attaching this entry again.",
      },
    },
  },
};
export const SuggestionsOnly: Story = {
  args: { entries: [], suggestions: [climbingLogFixture], onAttach: fn() },
};
