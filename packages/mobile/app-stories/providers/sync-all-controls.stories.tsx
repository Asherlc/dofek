import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { within } from "storybook/test";
import { SyncAllControls } from "../../app/providers/sync-all-controls";
import { colors } from "../../theme";

const meta = {
  title: "Providers/SyncAllControls",
  component: SyncAllControls,
  decorators: [
    (Story) => (
      <View style={{ backgroundColor: colors.background, padding: 16, width: 360 }}>
        <Story />
      </View>
    ),
  ],
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
