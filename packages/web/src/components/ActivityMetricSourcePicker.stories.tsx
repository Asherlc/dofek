import {
  type ActivityMetricSource,
  activityMetricSourcePresentation,
} from "@dofek/providers/activity-metric-source";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker.tsx";

const sources: ActivityMetricSource[] = [
  {
    id: "watch",
    label: "Asher’s Apple Watch (via Apple Health)",
    presentation: {
      displayName: "Asher’s Apple Watch",
      providerId: "apple_health",
      sourceName: "Asher’s Apple Watch",
      attribution: { kind: "apple_health", label: "Apple Health" },
    },
  },
  {
    id: "whoop-cloud",
    label: "WHOOP (Cloud)",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop",
      sourceName: null,
      attribution: { kind: "cloud", label: "Cloud" },
    },
  },
  {
    id: "whoop-bluetooth",
    label: "WHOOP (Bluetooth)",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop_ble",
      sourceName: null,
      attribution: { kind: "bluetooth", label: "Bluetooth" },
    },
  },
  {
    id: "fit-file",
    label: "Garmin Edge 1050 · Recorded by Garmin Edge 1050 · FIT file creator Garmin",
    presentation: {
      displayName: "Garmin Edge 1050",
      providerId: "garmin",
      sourceName: "Edge 1050",
      attribution: null,
    },
  },
  {
    id: "unknown",
    label: "Imported recording",
    presentation: {
      displayName: "Imported recording",
      providerId: "unknown-recorder",
      sourceName: null,
      attribution: null,
    },
  },
];

const meta = {
  title: "Activity/Metric source picker",
  component: ActivityMetricSourcePicker,
  parameters: { layout: "centered" },
  args: { label: "Heart Rate", sources, selectedId: "watch", onChange: () => {} },
  render: function PickerStory(args) {
    const [selectedId, setSelectedId] = useState(args.selectedId);
    return (
      <ActivityMetricSourcePicker {...args} selectedId={selectedId} onChange={setSelectedId} />
    );
  },
} satisfies Meta<typeof ActivityMetricSourcePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AppleHealth: Story = {};
export const Cloud: Story = { args: { selectedId: "whoop-cloud" } };
export const Bluetooth: Story = { args: { selectedId: "whoop-bluetooth" } };
export const RecorderDetails: Story = { args: { selectedId: "fit-file" } };
export const UnknownAttribution: Story = { args: { selectedId: "unknown" } };

export const ProviderLogos: Story = {
  args: {
    label: "Power",
    selectedId: "peloton",
    sources: [
      {
        id: "peloton",
        label: "Peloton",
        presentation: activityMetricSourcePresentation("peloton", null, "Peloton"),
      },
      {
        id: "strava",
        label: "Strava · recorded by Peloton Bike",
        presentation: activityMetricSourcePresentation(
          "strava",
          null,
          "Strava · recorded by Peloton Bike",
          "Peloton Bike",
        ),
      },
    ],
  },
  play: async ({ canvasElement, userEvent }) => {
    const trigger = within(canvasElement).getByRole("button", { name: "Power source: Peloton" });
    await expect(trigger).toHaveTextContent("");
    await userEvent.click(trigger);
    const dropdown = within(canvasElement.ownerDocument.body).getByRole("dialog", {
      name: "Power source",
    });
    await expect(within(dropdown).getByRole("radio", { name: "Peloton" })).toBeChecked();
    await expect(within(dropdown).getByText("Peloton Bike")).toBeVisible();
  },
};

export const OpenDropdown: Story = {
  args: { selectedId: "whoop-cloud" },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /Heart Rate source/ }));
    const dropdown = within(canvasElement.ownerDocument.body).getByRole("dialog", {
      name: "Heart Rate source",
    });
    await expect(dropdown).toBeVisible();
    await expect(within(dropdown).getByRole("radio", { name: "WHOOP (Cloud)" })).toBeChecked();
  },
};
