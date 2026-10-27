import type { Meta, StoryObj } from "@storybook/react-vite";
import { CorrelationStrengthBar } from "./CorrelationStrengthBar.tsx";

const meta = {
  title: "Charts/CorrelationStrengthBar",
  component: CorrelationStrengthBar,
  args: {
    rho: 0.72,
  },
  decorators: [
    (Story) => (
      <div className="w-80 p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CorrelationStrengthBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Positive: Story = {};
export const Negative: Story = { args: { rho: -0.58 } };
export const Neutral: Story = { args: { rho: 0 } };
export const Clamped: Story = { args: { rho: 1.4 } };
