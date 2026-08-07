import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";

const meta = {
  title: "Charts/ChartDescriptionTooltip",
  component: ChartDescriptionTooltip,
  parameters: {
    docs: {
      description: {
        component:
          "A labeled 44-pixel control that opens a keyboard-accessible, dismissible chart explanation.",
      },
    },
  },
  args: {
    description:
      "This chart compares your current values with the rolling average for the selected period.",
  },
  decorators: [
    (Story) => (
      <div className="flex h-40 items-end justify-center p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChartDescriptionTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LongDescription: Story = {
  args: {
    description:
      "A longer explanation that describes the metric, the comparison window, and how to interpret changes without requiring domain expertise.",
  },
};
