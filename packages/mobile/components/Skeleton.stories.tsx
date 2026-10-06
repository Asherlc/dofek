import type { Meta, StoryObj } from "@storybook/react-native";
import { SkeletonCircle } from "./Skeleton";

const meta = {
  title: "Components/Skeleton",
  component: SkeletonCircle,
} satisfies Meta<typeof SkeletonCircle>;

export default meta;

export const Circle: StoryObj<typeof SkeletonCircle> = {
  args: { size: 60 },
};
