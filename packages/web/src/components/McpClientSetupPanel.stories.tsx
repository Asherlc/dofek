import type { Meta, StoryObj } from "@storybook/react-vite";
import { McpClientSetupPanel } from "./McpClientSetupPanel.tsx";

const meta = {
  title: "Settings/McpClientSetupPanel",
  component: McpClientSetupPanel,
  args: { endpoint: "https://dofek.fit/api/mcp" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl bg-background p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpClientSetupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
