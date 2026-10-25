import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import {
  branchingSourceTree,
  longSourceTree,
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
export const WithDeviceFacts: Story = {
  args: { hardware: sourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Connect Sources" }));
    await expect(canvas.getByText("12345678")).toBeVisible();
    await expect(canvas.getByText("Whoop")).toBeVisible();
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
    await expect(within(canvasElement).queryByRole("button", { name: "Sources" })).toBeNull();
  },
};
export const Expanded: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Connect Sources" }));
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
  },
};
export const StrongViaAppleHealth: Story = { args: { tree: strongSourceTree } };
export const UnresolvedSources: Story = {
  args: { tree: { primary: null, otherSources: branchingSourceTree.otherSources } },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Sources" }));
  },
};
export const KeyboardDisclosure: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const trigger = within(canvasElement).getByRole("button", { name: "Garmin Connect Sources" });
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
    await expect(textElements).toHaveLength(6);
    for (const element of textElements) {
      const textBounds = element.getBoundingClientRect();
      await expect(textBounds.right).toBeLessThanOrEqual(bounds.right);
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    }
  },
};
