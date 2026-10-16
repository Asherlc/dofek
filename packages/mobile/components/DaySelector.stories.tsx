import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { View } from "react-native";
import { DaySelector } from "./DaySelector";

const meta = {
  title: "Components/DaySelector",
  component: DaySelector,
  args: {
    days: 7,
    onChange: () => {},
  },
} satisfies Meta<typeof DaySelector>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => {
    const [days, setDays] = useState(args.days);
    return (
      <View style={{ padding: 20 }}>
        <DaySelector {...args} days={days} onChange={setDays} />
      </View>
    );
  },
};

export const CustomOptions: Story = {
  args: {
    days: 30,
    options: [
      { label: "1m", value: 30 },
      { label: "3m", value: 90 },
      { label: "6m", value: 180 },
      { label: "1y", value: 365 },
    ],
    onChange: () => {},
  },
  render: (args) => {
    const [days, setDays] = useState(args.days);
    return (
      <View style={{ padding: 20 }}>
        <DaySelector {...args} days={days} onChange={setDays} />
      </View>
    );
  },
};
