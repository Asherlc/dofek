import type { ActivityImage } from "@dofek/training/activity-images";

export const activityPhotoFixture: ActivityImage = {
  id: "photo-1",
  url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#b4d9e7"/><circle cx="960" cy="150" r="70" fill="#f8e5a1"/><path d="M0 650L360 130L730 650Z" fill="#718c93"/><path d="M450 800L890 280L1200 650V800Z" fill="#526f71"/><path d="M0 680Q300 560 600 700T1200 670V800H0Z" fill="#476a50"/></svg>')}`,
  width: 1200,
  height: 800,
  mimeType: "image/jpeg",
  sizeBytes: 12000,
  sources: [
    {
      activityId: "activity-1",
      providerId: "strava",
      sourceId: "source-1",
      kind: "photo",
      caption: "View from the summit",
      position: 0,
    },
  ],
};
