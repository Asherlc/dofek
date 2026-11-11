import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { within } from "storybook/test";
import { ActivityImages, ActivityPhoto } from "./ActivityImages";
import { activityImageFixture } from "./activity-images-test-helpers";

const photo = {
  ...activityImageFixture,
  url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80",
};

const meta = {
  title: "Activity/ActivityImages",
  component: ActivityImages,
  args: { images: [photo], onRetry: () => undefined },
  decorators: [
    (Story) => (
      <View style={{ width: 360, maxWidth: "100%" }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivityImages>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const MultiplePhotos: Story = {
  args: { images: [photo, { ...photo, id: "photo-2", sources: [] }, { ...photo, id: "photo-3" }] },
};
export const Loading: Story = { args: { images: [], loading: true } };
export const Empty: Story = { args: { images: [] } };
export const LoadError: Story = {
  args: { images: [], error: new Error("Photos could not be loaded. Try again.") },
};
export const RefreshError: Story = {
  args: { error: new Error("Photos could not be refreshed. Try again.") },
};
export const FullScreen: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Open photo 1: View from the summit",
      }),
    );
  },
};
export const Photo: Story = {
  render: () => (
    <ActivityPhoto image={photo} style={{ width: 360, height: 240 }} onRetry={() => undefined} />
  ),
};
