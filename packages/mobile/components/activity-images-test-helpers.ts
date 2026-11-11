import type { ActivityImage } from "@dofek/training/activity-images";

export const activityImageFixture: ActivityImage = {
  id: "photo-1",
  url: "https://images.example.test/photo.jpg?signature=private",
  width: 1200,
  height: 800,
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  sources: [
    {
      activityId: "activity-1",
      providerId: "strava",
      sourceId: "source-photo-1",
      kind: "photo",
      caption: "View from the summit",
      position: 0,
    },
  ],
};
