import type { Meta, StoryObj } from "@storybook/react-native";
import { expect, fn, within } from "storybook/test";
import { ScreenSections } from "./ScreenSections";

const meta = {
  title: "Navigation/ScreenSections",
  component: ScreenSections,
  args: {
    label: "Activity sections",
    sections: [
      { id: "overview", title: "Overview" },
      { id: "performance", title: "Performance" },
      { id: "details", title: "Details" },
    ],
    selected: "overview",
    onSelect: fn(),
  },
} satisfies Meta<typeof ScreenSections>;

export default meta;
export const Default: StoryObj<typeof meta> = {};

export const Empty: StoryObj<typeof meta> = { args: { sections: [] } };

export const PerformanceMetrics: StoryObj<typeof meta> = {
  args: {
    label: "Performance metrics",
    sections: [
      { id: "heartRate", title: "Heart Rate" },
      { id: "power", title: "Power" },
      { id: "speed", title: "Speed" },
      { id: "cadence", title: "Cadence" },
      { id: "altitude", title: "Elevation" },
      { id: "skinTemperature", title: "Skin Temperature" },
    ],
    selected: "skinTemperature",
  },
};

export const CompactPerformanceMetrics: StoryObj<typeof meta> = {
  args: {
    ...PerformanceMetrics.args,
    compact: true,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const trigger = await canvas.findByRole("button", {
      name: "Performance metrics: Skin Temperature",
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(canvas.getByRole("dialog", { name: "Performance metrics" })).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Skin Temperature" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: "Power" }));
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  },
};
