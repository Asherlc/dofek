import type { Meta, StoryObj } from "@storybook/react-vite";
import { activityPhotoFixture } from "./ActivityPhoto.fixtures.ts";
import { ActivityPhotos } from "./ActivityPhotos.tsx";

const meta = {
  title: "Activity/ActivityPhotos",
  component: ActivityPhotos,
  parameters: { layout: "padded" },
  args: { images: [activityPhotoFixture], loading: false, error: null, onRetry: () => {} },
} satisfies Meta<typeof ActivityPhotos>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const MultiplePhotos: Story = {
  args: {
    images: [
      activityPhotoFixture,
      {
        ...activityPhotoFixture,
        id: "photo-2",
        sources: activityPhotoFixture.sources.map((source) => ({
          ...source,
          caption: "After the climb",
        })),
      },
    ],
  },
};
export const Loading: Story = { args: { images: [], loading: true } };
export const Empty: Story = { args: { images: [] } };
export const QueryError: Story = {
  args: { images: [], error: new Error("Photo storage is unavailable. Try again.") },
};
export const RefreshError: Story = {
  args: { error: new Error("You are offline. Reconnect and refresh photos.") },
};
