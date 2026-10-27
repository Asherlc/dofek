import type { Meta, StoryObj } from "@storybook/react-native";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";

const meta = {
  title: "Components/ChartDescriptionTooltip",
  component: ChartDescriptionTooltip,
  args: {
    title: "Ramp Rate",
    description: "Weekly change in training load; positive values are increases.",
  },
} satisfies Meta<typeof ChartDescriptionTooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
