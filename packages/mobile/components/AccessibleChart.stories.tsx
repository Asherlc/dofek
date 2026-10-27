import type { Meta, StoryObj } from "@storybook/react-native";
import { StyleSheet, Text, View } from "react-native";
import { AccessibleChart } from "./AccessibleChart";

const styles = StyleSheet.create({
  preview: {
    alignItems: "center",
    backgroundColor: "#e8ede7",
    height: 140,
    justifyContent: "center",
  },
});

const meta = {
  title: "Components/AccessibleChart",
  component: AccessibleChart,
  args: {
    title: "Heart rate",
    summary: "Heart rate over the recorded sample sequence.",
    rows: [
      { label: "Sample 1", value: "72 beats per minute" },
      { label: "Sample 2", value: "74 beats per minute" },
    ],
    children: (
      <View style={styles.preview}>
        <Text>Chart preview</Text>
      </View>
    ),
  },
} satisfies Meta<typeof AccessibleChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EmptyData: Story = {
  args: {
    rows: [],
    summary: "No chart data is available.",
  },
};
