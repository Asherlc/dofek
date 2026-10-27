import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusDot } from "./StatusDot.tsx";

const meta = {
  title: "Providers/StatusDot",
  component: StatusDot,
  args: {
    status: "idle",
  },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-2 p-4 text-sm text-foreground">
        <Story />
        Provider status
      </div>
    ),
  ],
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};
export const Syncing: Story = { args: { status: "syncing" } };
export const Done: Story = { args: { status: "done" } };
export const ErrorStatus: Story = { args: { status: "error" } };
