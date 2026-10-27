import type { ActivityMetricSource } from "@dofek/providers/activity-metric-source";
import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { Platform, View } from "react-native";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker";

const watch: ActivityMetricSource = {
  id: "watch",
  label: "Asher’s Apple Watch (via Apple Health; recorded by Workout)",
  presentation: {
    displayName: "Asher’s Apple Watch",
    providerId: "apple_health",
    sourceName: "Asher’s Apple Watch",
    attribution: { kind: "apple_health", label: "via Apple Health" },
  },
};
const cloud: ActivityMetricSource = {
  id: "whoop-cloud",
  label: "WHOOP (via WHOOP Cloud)",
  presentation: {
    displayName: "WHOOP",
    providerId: "whoop",
    sourceName: null,
    attribution: { kind: "cloud", label: "via WHOOP Cloud" },
  },
};
const bluetooth: ActivityMetricSource = {
  id: "whoop-bluetooth",
  label: "WHOOP (via Bluetooth)",
  presentation: {
    displayName: "WHOOP",
    providerId: "whoop",
    sourceName: null,
    attribution: { kind: "bluetooth", label: "via Bluetooth" },
  },
};
const meta = {
  title: "Activity/ActivityMetricSourcePicker",
  component: ActivityMetricSourcePicker,
  args: {
    label: "Heart Rate",
    sources: [cloud, bluetooth, watch],
    selectedId: cloud.id,
    serverUrl: Platform.OS === "web" ? "" : "https://dofek.fit",
    onChange: () => undefined,
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  render: function SourcePickerStory(args) {
    const [selectedId, setSelectedId] = useState(args.selectedId);
    return (
      <ActivityMetricSourcePicker {...args} selectedId={selectedId} onChange={setSelectedId} />
    );
  },
} satisfies Meta<typeof ActivityMetricSourcePicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const AppleHealth: Story = { args: { selectedId: watch.id } };
export const Bluetooth: Story = { args: { selectedId: bluetooth.id } };
export const Elevation: Story = {
  args: { label: "Elevation", showLabel: false, selectedId: watch.id },
};
export const NoAttribution: Story = {
  args: {
    selectedId: "import",
    sources: [
      {
        id: "import",
        label: "FIT Import",
        presentation: {
          displayName: "FIT Import",
          providerId: "fit",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
};
export const Empty: Story = { args: { sources: [], selectedId: "" } };
export const LongSourceName: Story = {
  args: {
    sources: [
      cloud,
      bluetooth,
      {
        ...watch,
        presentation: {
          ...watch.presentation,
          displayName: "Asher’s Apple Watch Ultra recording",
        },
      },
    ],
    selectedId: watch.id,
  },
};
