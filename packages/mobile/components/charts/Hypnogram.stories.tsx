import type { Meta, StoryObj } from "@storybook/react";
import { Hypnogram } from "./Hypnogram";

const meta = {
  title: "Charts/Hypnogram",
  component: Hypnogram,
  args: {
    data: [
      {
        stage: "deep",
        started_at: "2026-07-01T22:00:00",
        ended_at: "2026-07-01T23:10:00",
      },
      {
        stage: "light",
        started_at: "2026-07-01T23:10:00",
        ended_at: "2026-07-01T23:45:00",
      },
      {
        stage: "rem",
        started_at: "2026-07-01T23:45:00",
        ended_at: "2026-07-02T00:15:00",
      },
    ],
  },
} satisfies Meta<typeof Hypnogram>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    data: [],
  },
};
