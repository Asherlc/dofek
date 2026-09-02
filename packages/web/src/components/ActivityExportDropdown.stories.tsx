import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityExportDropdown } from "./ActivityExportDropdown.tsx";

const meta = {
  title: "Activities/ActivityExportDropdown",
  component: ActivityExportDropdown,
  tags: ["autodocs"],
  args: {
    activityId: "00000000-0000-0000-0000-000000000001",
    hasGps: true,
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-48 justify-center bg-page p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityExportDropdown>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutGps: Story = {
  args: {
    hasGps: false,
  },
};
