import type { Meta, StoryObj } from "@storybook/react-native";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";

const meta = {
  title: "Components/ChartDescriptionTooltip",
  component: ChartDescriptionTooltip,
  args: {
    title: "Ramp Rate",
    description: "This chart shows how quickly your training load is changing week to week.",
  },
} satisfies Meta<typeof ChartDescriptionTooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
