import type { Meta, StoryObj } from "@storybook/react-vite";
import { activityPhotoFixture } from "./ActivityPhoto.fixtures.ts";
import { ActivityPhoto } from "./ActivityPhoto.tsx";

const meta = {
  title: "Activity/ActivityPhoto",
  component: ActivityPhoto,
  args: { image: activityPhotoFixture, className: "h-64 w-80" },
} satisfies Meta<typeof ActivityPhoto>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Uncropped: Story = { args: { fit: "contain" } };
export const LoadError: Story = {
  args: { image: { ...activityPhotoFixture, url: "data:image/png;base64,invalid" } },
};
