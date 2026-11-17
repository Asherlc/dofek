import type { Meta, StoryObj } from "@storybook/react-vite";
import { Hypnogram } from "./Hypnogram";

const sampleStages = [
  {
    stage: "light",
    started_at: "2026-04-02T22:15:00",
    ended_at: "2026-04-02T22:45:00",
    duration_seconds: 1800,
  },
  {
    stage: "deep",
    started_at: "2026-04-02T22:45:00",
    ended_at: "2026-04-02T23:30:00",
    duration_seconds: 2700,
  },
  {
    stage: "light",
    started_at: "2026-04-02T23:30:00",
    ended_at: "2026-04-03T00:00:00",
    duration_seconds: 1800,
  },
  {
    stage: "rem",
    started_at: "2026-04-03T00:00:00",
    ended_at: "2026-04-03T00:45:00",
    duration_seconds: 2700,
  },
  {
    stage: "light",
    started_at: "2026-04-03T00:45:00",
    ended_at: "2026-04-03T01:30:00",
    duration_seconds: 2700,
  },
  {
    stage: "deep",
    started_at: "2026-04-03T01:30:00",
    ended_at: "2026-04-03T02:15:00",
    duration_seconds: 2700,
  },
  {
    stage: "awake",
    started_at: "2026-04-03T02:15:00",
    ended_at: "2026-04-03T02:25:00",
    duration_seconds: 600,
  },
  {
    stage: "light",
    started_at: "2026-04-03T02:25:00",
    ended_at: "2026-04-03T03:00:00",
    duration_seconds: 2100,
  },
  {
    stage: "rem",
    started_at: "2026-04-03T03:00:00",
    ended_at: "2026-04-03T04:00:00",
    duration_seconds: 3600,
  },
  {
    stage: "light",
    started_at: "2026-04-03T04:00:00",
    ended_at: "2026-04-03T05:00:00",
    duration_seconds: 3600,
  },
  {
    stage: "deep",
    started_at: "2026-04-03T05:00:00",
    ended_at: "2026-04-03T05:30:00",
    duration_seconds: 1800,
  },
  {
    stage: "light",
    started_at: "2026-04-03T05:30:00",
    ended_at: "2026-04-03T06:00:00",
    duration_seconds: 1800,
  },
];

const meta = {
  title: "Sleep/Hypnogram",
  component: Hypnogram,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: "100%", maxWidth: 1000 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    data: sampleStages,
  },
} satisfies Meta<typeof Hypnogram>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

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

export const SingleStage: Story = { args: { data: sampleStages.slice(0, 1) } };

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};

export const Loading: Story = {
  args: { loading: true },
};

export const NoStages: Story = {
  args: { data: [] },
};
