import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { ActivityExportMenu } from "./ActivityExportMenu";

const meta = {
  title: "Activity/ActivityExportMenu",
  component: ActivityExportMenu,
  args: {
    visible: true,
    options: [
      { accessibilityLabel: "GPS track (GPX)", label: "GPX", format: "gpx" },
      { accessibilityLabel: "Training Center data (TCX)", label: "TCX", format: "tcx" },
      { accessibilityLabel: "comma-separated values (CSV)", label: "CSV", format: "csv" },
      { accessibilityLabel: "fitness activity file (FIT)", label: "FIT", format: "fit" },
    ],
    exportingFormat: null,
    onSelect: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof ActivityExportMenu>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Exporting: Story = { args: { exportingFormat: "csv" } };
export const NoRoute: Story = {
  args: {
    options: meta.args.options.map((option) => ({
      ...option,
      disabled: option.format === "gpx" || option.format === "tcx",
    })),
  },
};
