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
      },
      {
        stage: "rem",
        started_at: "2026-07-01T22:30:00",
        ended_at: "2026-07-01T23:00:00",
      },
      {
        stage: "light",
        started_at: "2026-07-01T23:00:00",
        ended_at: "2026-07-02T00:00:00",
      },
      {
        stage: "awake",
        started_at: "2026-07-02T00:00:00",
        ended_at: "2026-07-02T00:10:00",
      },
    ],
  },
} satisfies Meta<typeof Hypnogram>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { data: [] },
};
