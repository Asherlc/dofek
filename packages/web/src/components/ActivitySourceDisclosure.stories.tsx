import { activitySourceTreeSchema } from "@dofek/providers/activity-source-tree";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import lineageExamples from "../../../../src/test-fixtures/activity-lineage.json";
import {
  branchingSourceTree,
  longSourceTree,
  recognizedWatchHardware,
  recognizedWatchSourceTree,
  sourceHardware,
  strongSourceTree,
} from "./ActivitySourceDisclosure.fixtures.ts";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure.tsx";

const meta = {
  title: "Activities/ActivitySourceDisclosure",
  component: ActivitySourceDisclosure,
  args: { tree: branchingSourceTree },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="bg-page p-4 text-foreground">
        <div className="card mx-auto max-w-xl overflow-hidden">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof ActivitySourceDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const RecognizedWatchModels: Story = {
  args: { tree: recognizedWatchSourceTree, hardware: recognizedWatchHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Apple Watch Series 7 (GPS + Cellular, 45mm) Lineage" }),
    );
    await expect(canvas.getByText("Garmin Forerunner 955")).toBeVisible();
  },
};
export const WithRecordingDevice: Story = {
  args: { hardware: sourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Edge 530 Lineage" }));
  },
};
export const LoadingDevices: Story = { args: { hardwareLoading: true } };
export const DeviceError: Story = {
  args: {
    hardwareError: new Error("Reconnect Garmin to load device details."),
    onRetryHardware: () => undefined,
  },
};
export const CachedDeviceError: Story = {
  args: {
    hardware: sourceHardware,
    hardwareError: new Error("Refresh failed. Retry this activity."),
    onRetryHardware: () => undefined,
  },
};
export const EmptyTree: Story = {
  args: { tree: { primary: null, otherSources: [] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button", { name: "Lineage" })).toBeNull();
  },
};
export const Expanded: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Connect Lineage" }));
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
  },
};
export const StrongViaAppleHealth: Story = { args: { tree: strongSourceTree } };
export const UnresolvedSources: Story = {
  args: { tree: { primary: null, otherSources: branchingSourceTree.otherSources } },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Lineage" }));
  },
};
export const KeyboardDisclosure: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const trigger = within(canvasElement).getByRole("button", { name: "Garmin Connect Lineage" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  },
};

export const LongSourceLabels: Story = {
  args: { tree: longSourceTree },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: /RecordingDeviceWithAnUnbrokenLongName/ });
    await userEvent.click(trigger);
    const disclosure = trigger.parentElement;
    if (!disclosure) throw new Error("Missing source disclosure");
    const bounds = disclosure.getBoundingClientRect();
    const textElements = canvas.getAllByText(/WithAnUnbrokenLong|WithoutWordBreaks/);
    await expect(textElements).toHaveLength(7);
    for (const element of textElements) {
      const textBounds = element.getBoundingClientRect();
      await expect(textBounds.right).toBeLessThanOrEqual(bounds.right);
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    }
  },
};

export const CloudRecording: Story = {
  args: {
    tree: {
      primary: {
        id: "whoop",
        providerId: "whoop",
        sourceName: null,
        label: "WHOOP (Cloud)",
        description: null,
        url: null,
        children: [
          {
            id: "health",
            providerId: "apple_health",
            sourceName: null,
            label: "Apple Health",
            description: null,
            url: null,
            children: [],
          },
          {
            id: "peloton",
            providerId: "peloton",
            sourceName: null,
            label: "Peloton",
            description: null,
            url: null,
            children: [],
          },
        ],
      },
      otherSources: [],
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "WHOOP (Cloud) Lineage" }));
    await expect(canvas.getAllByText("WHOOP")[0]).toBeVisible();
    await expect(canvas.getAllByTitle("Cloud")[0]).toBeVisible();
  },
};

export const SingleRecording: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.single),
    heading: <h1>Evening ride</h1>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(
      async () =>
        await expect(
          within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
        ).toBeVisible(),
    );
    const dialog = within(
      within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
    );
    await expect(dialog.getByText("Original")).toBeVisible();
    await expect(dialog.getByText("Garmin Edge 530")).toBeVisible();
  },
};

export const SharingChain: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.chain),
    heading: <h1>Evening ride</h1>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(
      async () =>
        await expect(
          within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
        ).toBeVisible(),
    );
    const dialog = within(
      within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
    );
    await expect(dialog.getAllByText("Shared to")).toHaveLength(2);
    await expect(dialog.getByText("Peloton Bike+")).toBeVisible();
    await expect(dialog.getByText("Strava")).toBeVisible();
    await expect(dialog.getByText("Apple Health")).toBeVisible();
  },
};

export const MultipleRecordings: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.multiple),
    heading: <h1>Evening ride</h1>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(
      async () =>
        await expect(
          within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
        ).toBeVisible(),
    );
    const dialog = within(
      within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
    );
    await expect(dialog.getAllByText("Other")).toHaveLength(1);
    await expect(dialog.getAllByText("Shared to")).toHaveLength(2);
    await expect(dialog.getByText("WHOOP")).toBeVisible();
    await expect(dialog.getByText("Garmin Forerunner 955")).toBeVisible();
  },
};

export const UnknownOrigin: Story = {
  args: {
    tree: activitySourceTreeSchema.parse(lineageExamples.unknown),
    heading: <h1>Evening ride</h1>,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Lineage/ }));
    await waitFor(
      async () =>
        await expect(
          within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
        ).toBeVisible(),
    );
    const dialog = within(
      within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Lineage" }),
    );
    await expect(dialog.getByText("Original unknown")).toBeVisible();
    await expect(dialog.getByText("Strava")).toBeVisible();
    await expect(dialog.getByText("WHOOP")).toBeVisible();
  },
};
