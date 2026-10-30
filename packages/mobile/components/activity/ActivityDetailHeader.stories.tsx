import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import {
  garminActivitySourceHardware,
  garminActivitySourceTree,
  walkingActivitySourceHardware,
  walkingActivitySourceTree,
} from "../../app-fixtures/activity-source-tree";
import { activityImageFixture } from "../activity-images-test-helpers";
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
    const canvas = within(canvasElement.ownerDocument.body);
    const trigger = await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getAllByText("Garmin Edge 530")).toHaveLength(1);
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
    await expect(canvas.getByText("WHOOP")).toBeVisible();
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
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources" }));
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};
export const EmptyTree: Story = {
  args: {
    activity: { ...detailHeaderActivity, sourceTree: { primary: null, otherSources: [] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Morning Ride")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Sources/ })).toBeNull();
  },
};
export const RemovedSource: Story = {
  args: { activity: removedDetailHeaderActivity },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" }));
    await expect(canvas.getByText("Removed from provider sync on March 5, 2026")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "View source for Garmin Edge 530" }),
    ).toBeNull();
  },
};

export const DeviceMetadataCollapsed: Story = {
  args: { hardware: garminActivitySourceHardware },
};
export const DeviceMetadataExpanded: Story = {
  args: { hardware: garminActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Sources: Garmin Edge 530" }));
    await expect(canvas.getByText("Firmware: 9.75")).toBeVisible();
    await expect(canvas.getByText("Peloton")).toBeVisible();
    await expect(canvas.getByText("Peloton Bike+")).toBeVisible();
    await expect(canvas.getByText("Morning Ride")).toBeVisible();
  },
};

export const WalkingCollapsed: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: "Walking",
      activityType: "walking",
      sourceTree: walkingActivitySourceTree,
    },
    hardware: walkingActivitySourceHardware,
  },
};
export const PrimarySourceWithoutTitle: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: null,
      activityType: "walking",
      primaryActivityType: "running",
      sourceTree: walkingActivitySourceTree,
    },
    hardware: walkingActivitySourceHardware,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Running")).toBeVisible();
    await expect(canvas.getByText("Walking")).toBeVisible();
  },
};
export const WalkingExpanded: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: "Walking",
      activityType: "walking",
      sourceTree: walkingActivitySourceTree,
    },
    hardware: walkingActivitySourceHardware,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Sources: Asher’s Apple Watch" }),
    );
    await expect(canvas.getByText("Serial number: WATCH-123")).toBeVisible();
    await expect(canvas.getByText("Peloton")).toBeVisible();
    await expect(canvas.getByText("Whoop")).toBeVisible();
  },
};

export const WithPhoto: Story = {
  args: {
    photos: {
      images: [
        {
          ...activityImageFixture,
          url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=300&q=80",
        },
      ],
      onRetry: () => undefined,
    },
  },
};
