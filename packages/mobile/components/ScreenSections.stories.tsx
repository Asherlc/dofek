import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
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
