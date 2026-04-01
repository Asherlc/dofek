import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { SkeletonCard, SkeletonCircle, SkeletonRect } from "./Skeleton";

const meta = {
  title: "Components/Skeleton",
  component: SkeletonRect,
} satisfies Meta<typeof SkeletonRect>;

export default meta;

export const Rect: StoryObj<typeof SkeletonRect> = {
  args: {
    width: 200,
    height: 20,
  },
};

export const Circle: StoryObj<typeof SkeletonCircle> = {
  render: () => <SkeletonCircle size={60} />,
};

export const Card: StoryObj<typeof SkeletonCard> = {
  render: () => <SkeletonCard />,
};

export const Layout: StoryObj<typeof SkeletonRect> = {
  render: () => (
    <View style={{ gap: 10 }}>
      <SkeletonRect width="80%" height={24} />
      <SkeletonRect width="100%" height={12} />
      <SkeletonRect width="100%" height={12} />
      <SkeletonRect width="60%" height={12} />
    </View>
  ),
};
