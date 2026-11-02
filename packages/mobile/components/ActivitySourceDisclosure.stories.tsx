import { activitySourceTreeSchema } from "@dofek/providers/activity-source-tree";
import type { Meta, StoryObj } from "@storybook/react-native";
import { Text, View } from "react-native";
import { expect, waitFor, within } from "storybook/test";
import lineageExamples from "../../../src/test-fixtures/activity-lineage.json";
import {
  branchingActivitySourceTree,
  garminActivitySourceHardware,
  garminActivitySourceTree,
  recognizedWatchHardware,
  recognizedWatchSourceTree,
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
export const RecognizedWatchModels: Story = {
  args: { tree: recognizedWatchSourceTree, hardware: recognizedWatchHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Lineage: Apple Watch Series 7 (GPS + Cellular, 45mm)",
      }),
    );
    await expect(canvas.getByText("Garmin Forerunner 955")).toBeVisible();
  },
};
export const EmptyTree: Story = {
  args: { tree: { primary: null, otherSources: [] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button", { name: "Lineage" })).toBeNull();
  },
};
export const BranchingExpanded: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole("button", { name: "Lineage: Hang Ten" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(await canvas.findByText("Apple Health")).toBeVisible();
    await expect(canvas.getAllByText("Strava")).toHaveLength(2);
    await expect(canvas.getAllByText("WHOOP")[0]).toBeVisible();
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
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage" }));
    await expect(await canvas.findByText("Apple Health")).toBeVisible();
  },
};

export const RecordingDeviceCollapsed: Story = {
  args: { tree: garminActivitySourceTree, hardware: garminActivitySourceHardware },
};
export const RecordingDeviceExpanded: Story = {
  args: { tree: garminActivitySourceTree, hardware: garminActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage: Garmin Edge 530" }));
    await expect(canvas.getByText("Peloton Bike+")).toBeVisible();
  },
};
export const HardwareOnly: Story = {
  args: { tree: { primary: null, otherSources: [] }, hardware: garminActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage" }));
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
      await canvas.findByRole("button", { name: "Lineage: Asher’s Apple Watch" }),
    );
    await expect(canvas.getByText("Peloton")).toBeVisible();
  },
};
export const HardwareLoading: Story = {
  args: { tree: { primary: null, otherSources: [] }, hardwareLoading: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage" }));
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
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage: Garmin Edge 530" }));
  },
};

export const SingleRecording: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.single),
    heading: <Text>Evening ride</Text>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(async () => {
      await expect(
        within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
      ).toBeVisible();
    });
  },
};

export const SharingChain: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.chain),
    heading: <Text>Evening ride</Text>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(async () => {
      await expect(
        within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
      ).toBeVisible();
    });
  },
};

export const MultipleRecordings: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.multiple),
    heading: <Text>Evening ride</Text>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(async () => {
      await expect(
        within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
      ).toBeVisible();
    });
  },
};

export const UnknownOrigin: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.unknown),
    heading: <Text>Evening ride</Text>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(async () => {
      await expect(
        within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
      ).toBeVisible();
    });
  },
};
