import type { Meta, StoryObj } from "@storybook/react-vite";
import { MethodExplanation } from "./MethodExplanation.tsx";

const meta = {
  title: "Training/MethodExplanation",
  component: MethodExplanation,
  tags: ["autodocs"],
  args: {
    className: "mt-2",
    lines: [
      "The first line describes the formula.",
      "The second line describes the calculation choices.",
      "The third line describes the interpretation.",
    ],
    source: {
      title: "Primary source",
      url: "https://example.com/primary-source",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MethodExplanation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
