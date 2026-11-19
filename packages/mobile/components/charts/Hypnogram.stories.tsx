import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { Hypnogram } from "./Hypnogram";

const meta = {
  title: "Charts/Hypnogram",
  component: Hypnogram,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: "#f5f7f2" }}>
        <Story />
      </View>
    ),
  ],
  args: {
    data: [
      {
        stage: "deep",
        started_at: "2026-07-01T22:00:00",
        ended_at: "2026-07-01T22:30:00",
        duration_seconds: 1800,
      },
      {
        stage: "rem",
        started_at: "2026-07-01T22:30:00",
        ended_at: "2026-07-01T23:00:00",
        duration_seconds: 1800,
      },
      {
        stage: "light",
        started_at: "2026-07-01T23:00:00",
        ended_at: "2026-07-02T00:00:00",
        duration_seconds: 3600,
      },
      {
        stage: "awake",
        started_at: "2026-07-02T00:00:00",
        ended_at: "2026-07-02T00:10:00",
        duration_seconds: 600,
      },
    ],
  },
} satisfies Meta<typeof Hypnogram>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Review at a 375pt device width with Accessibility Extra Large text enabled:
// stage labels must keep their own column instead of covering the lane bars.
export const Narrow375pt: Story = {
  name: "Narrow 375pt · accessibility text",
  args: {
    data: [
      {
        stage: "deep",
        started_at: "2026-07-01T22:30:00",
        ended_at: "2026-07-01T23:30:00",
        duration_seconds: 3600,
      },
      {
        stage: "light",
        started_at: "2026-07-01T23:30:00",
        ended_at: "2026-07-02T09:30:00",
        duration_seconds: 36000,
      },
      {
        stage: "awake",
        started_at: "2026-07-02T09:30:00",
        ended_at: "2026-07-02T11:30:00",
        duration_seconds: 7200,
      },
    ],
  },
  decorators: [
    (Story) => (
      <View style={{ width: 343, backgroundColor: "#f5f7f2" }}>
        <Story />
      </View>
    ),
  ],
};

export const GapsAndBriefAwakenings: Story = {
  args: {
    data: [
      {
        stage: "deep",
        started_at: "2026-11-15T23:00:00",
        ended_at: "2026-11-15T23:30:00",
        duration_seconds: 1800,
      },
      {
        stage: "awake",
        started_at: "2026-11-16T00:00:00",
        ended_at: "2026-11-16T00:00:15",
        duration_seconds: 15,
      },
      {
        stage: "rem",
        started_at: "2026-11-16T00:00:15",
        ended_at: "2026-11-16T01:00:00",
        duration_seconds: 3585,
      },
      {
        stage: "light",
        started_at: "2026-11-16T01:00:00",
        ended_at: "2026-11-16T02:00:00",
        duration_seconds: 3600,
      },
    ],
  },
};

export const SingleStage: Story = { args: { data: meta.args.data.slice(0, 1) } };

export const Empty: Story = {
  args: { data: [] },
};
