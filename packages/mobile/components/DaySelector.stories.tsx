import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { View } from "react-native";
import { DaySelector } from "./DaySelector";

const meta = {
  title: "Components/DaySelector",
  component: DaySelector,
} satisfies Meta<typeof DaySelector>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [days, setDays] = useState(7);
    return (
      <View style={{ padding: 20 }}>
        <DaySelector days={days} onChange={setDays} />
      </View>
    );
  },
};

export const CustomOptions: Story = {
  render: () => {
    const [days, setDays] = useState(30);
    return (
      <View style={{ padding: 20 }}>
        <DaySelector
          days={days}
          onChange={setDays}
          options={[
            { label: "1m", value: 30 },
            { label: "3m", value: 90 },
            { label: "6m", value: 180 },
            { label: "1y", value: 365 },
          ]}
        />
      </View>
    );
  },
};
