import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { SyncAllControls } from "./SyncAllControls.tsx";

const meta = {
  title: "Providers/SyncAllControls",
  component: SyncAllControls,
  decorators: [(Story) => <div className="w-[360px] bg-background p-4">{Story()}</div>],
  args: {
    busy: false,
    onFullSync: () => {},
    onRecentSync: () => {},
  },
} satisfies Meta<typeof SyncAllControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FullHistoryConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Sync full history for all providers",
      }),
    );
  },
};

export const Syncing: Story = {
  args: { busy: true },
};

export const ErrorState: Story = {
  args: { errorMessage: "Garmin credentials expired. Reconnect Garmin." },
};
