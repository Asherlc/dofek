import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ZeppPairingPanelBody } from "./ZeppPairingPanel.tsx";

const meta = {
  title: "Settings/ZeppPairingPanel",
  component: ZeppPairingPanelBody,
  args: {
    connections: [],
    connectionsError: null,
    disconnectError: null,
    isConnectionsLoading: false,
    isPairingError: false,
    isPairingPending: false,
    pairingCode: "ABC234",
    pairingMessage: null,
    onDisconnect: fn(),
    onPairingCodeChange: fn(),
    onSubmit: fn(),
  },
} satisfies Meta<typeof ZeppPairingPanelBody>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Connected: Story = {
  args: {
    connections: [{ connectionType: "zepp-main" }],
    pairingCode: "",
    pairingMessage: "Zepp app connected. Return to Zepp to sync.",
  },
};
