import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { NavigationMenu } from "./NavigationMenu";

const meta = {
  title: "Navigation/NavigationMenu",
  component: NavigationMenu,
  args: {
    groups: [
      [
        { title: "Body", subtitle: "Vitals and body composition", onPress: fn() },
        { title: "Nutrition", subtitle: "Daily log and analytics", onPress: fn() },
        { title: "Correlation", subtitle: "Explore pairs of measurements", onPress: fn() },
      ],
      [{ title: "Settings", onPress: fn() }],
    ],
  },
} satisfies Meta<typeof NavigationMenu>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
