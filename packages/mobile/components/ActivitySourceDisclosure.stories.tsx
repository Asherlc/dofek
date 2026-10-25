import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import { branchingActivitySourceTree } from "../app-fixtures/activity-source-tree";
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
    await expect(canvas.getByText("Other matching sources")).toBeVisible();
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
    await expect(await canvas.findByText("Other matching sources")).toBeVisible();
  },
};
