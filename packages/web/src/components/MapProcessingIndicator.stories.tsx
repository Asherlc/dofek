import type { Meta, StoryObj } from "@storybook/react-vite";
import { MapProcessingIndicator } from "./MapProcessingIndicator.tsx";

const meta = {
  title: "Activities/MapProcessingIndicator",
  component: MapProcessingIndicator,
  decorators: [
    (Story) => (
      <div className="relative h-48 w-80 rounded-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MapProcessingIndicator>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Compact: Story = {
  args: { compact: true },
  decorators: [
    (Story) => (
      <div className="relative h-12 w-16 rounded">
        <Story />
      </div>
    ),
  ],
};
