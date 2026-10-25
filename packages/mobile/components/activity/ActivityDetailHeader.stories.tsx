import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import { garminActivitySourceTree } from "../../app-fixtures/activity-source-tree";
import { ActivityDetailHeader } from "./ActivityDetailHeader";
import { detailHeaderActivity, removedDetailHeaderActivity } from "./ActivityDetailHeader.fixtures";

const meta = {
  title: "Pages/ActivityDetail/ActivityDetailHeader",
  component: ActivityDetailHeader,
  args: { activity: detailHeaderActivity },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: "100%", maxWidth: 560 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivityDetailHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BranchingSourcesCollapsed: Story = {};
export const BranchingSourcesExpanded: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getAllByText("Garmin Edge 530")).toHaveLength(1);
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
    await expect(canvas.getByText("Other matching sources")).toBeVisible();
  },
};
export const UnresolvedSources: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      sourceTree: { primary: null, otherSources: garminActivitySourceTree.otherSources },
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources" }));
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};
export const EmptyTree: Story = {
  args: {
    activity: { ...detailHeaderActivity, sourceTree: { primary: null, otherSources: [] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Morning Ride")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Sources/ })).toBeNull();
  },
};
export const RemovedSource: Story = {
  args: { activity: removedDetailHeaderActivity },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" }));
    await expect(canvas.getByText("Removed from provider sync on March 5, 2026")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "View source for Garmin Edge 530" }),
    ).toBeNull();
  },
};
