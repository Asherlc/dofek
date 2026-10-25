import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import {
  branchingActivitySourceTree,
  garminActivitySourceHardware,
  garminActivitySourceTree,
  walkingActivitySourceHardware,
  walkingActivitySourceTree,
} from "../app-fixtures/activity-source-tree";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure";

const meta = {
  title: "Activities/ActivitySourceDisclosure",
  component: ActivitySourceDisclosure,
  args: { tree: branchingActivitySourceTree },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: "100%", maxWidth: 560 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivitySourceDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BranchingCollapsed: Story = {};
export const EmptyTree: Story = {
  args: { tree: { primary: null, otherSources: [] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button", { name: "Sources" })).toBeNull();
  },
};
export const BranchingExpanded: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole("button", { name: "Sources: Hang Ten" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(await canvas.findByText("Apple Health")).toBeVisible();
    await expect(canvas.getAllByText("Strava")).toHaveLength(2);
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};
export const DirectWhoop: Story = {
  args: {
    tree: { primary: branchingActivitySourceTree.otherSources[0] ?? null, otherSources: [] },
  },
};
export const UnknownRecordingApp: Story = {
  args: {
    tree: {
      ...branchingActivitySourceTree,
      primary: branchingActivitySourceTree.primary
        ? {
            ...branchingActivitySourceTree.primary,
            providerId: "my-training-app",
            label: "My Training App",
          }
        : null,
    },
  },
};
export const UnresolvedOrigin: Story = {
  args: {
    tree: { primary: null, otherSources: branchingActivitySourceTree.primary?.children ?? [] },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources" }));
    await expect(await canvas.findByText("Apple Health")).toBeVisible();
  },
};

export const DeviceMetadataCollapsed: Story = {
  args: { tree: garminActivitySourceTree, hardware: garminActivitySourceHardware },
};
export const DeviceMetadataExpanded: Story = {
  args: { tree: garminActivitySourceTree, hardware: garminActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" }));
    await expect(canvas.getByText("Firmware: 9.75")).toBeVisible();
    await expect(canvas.getByText("Battery voltage: 2.8 V")).toBeVisible();
    await expect(canvas.getByText("Peloton")).toBeVisible();
    await expect(canvas.getByText("Peloton Bike+")).toBeVisible();
  },
};
export const HardwareOnly: Story = {
  args: { tree: { primary: null, otherSources: [] }, hardware: garminActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources" }));
    await expect(canvas.getByText("Firmware: 9.75")).toBeVisible();
  },
};
export const WalkingCollapsed: Story = {
  args: { tree: walkingActivitySourceTree, hardware: walkingActivitySourceHardware },
};
export const WalkingExpanded: Story = {
  args: { tree: walkingActivitySourceTree, hardware: walkingActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Sources: Asher’s Apple Watch" }),
    );
    await expect(canvas.getByText("Serial number: WATCH-123")).toBeVisible();
    await expect(canvas.getByText("Peloton")).toBeVisible();
    await expect(canvas.getByText("Whoop")).toBeVisible();
  },
};
export const HardwareLoading: Story = {
  args: { tree: { primary: null, otherSources: [] }, hardwareLoading: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources" }));
    await expect(canvas.getByTestId("query-state-loading")).toBeVisible();
  },
};
export const HardwareError: Story = {
  args: {
    tree: { primary: null, otherSources: [] },
    hardwareError: new Error("Reconnect your provider, then retry device metadata."),
    onRetryHardware: () => undefined,
  },
};
export const CachedHardwareError: Story = {
  args: {
    tree: garminActivitySourceTree,
    hardware: garminActivitySourceHardware,
    hardwareError: new Error("Refresh failed. Retry device metadata."),
    onRetryHardware: () => undefined,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toBeVisible();
    await userEvent.click(await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" }));
    await expect(canvas.getByText("Firmware: 9.75")).toBeVisible();
  },
};
