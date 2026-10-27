import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ZeppPairingPanelBody } from "./ZeppPairingPanel.tsx";

const meta = {
  title: "Settings/ZeppPairingPanel",
  component: ZeppPairingPanelBody,
  args: {
    connectionsState: { status: "success", connections: [] },
    disconnectError: null,
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

export const Loading: Story = {
  args: {
    connectionsState: { status: "loading" },
  },
};

export const ErrorState: Story = {
  args: {
    connectionsState: {
      status: "error",
      error: new Error("Could not load Zepp connections"),
    },
  },
};

export const Connected: Story = {
  args: {
    connectionsState: {
      status: "success",
      connections: [{ connectionType: "zepp-main" }],
    },
    pairingCode: "",
    pairingMessage: "Zepp app connected. Return to Zepp to sync.",
  },
};
