import type { ActivityLocation } from "dofek-server/types";

export const climbingSourceLocation = {
  kind: "climbing_source",
  mapPreview: {
    width: 1024,
    height: 576,
    center: [-105.39999996, 40.00700003],
    zoom: 13,
    routePath: null,
  },
  sourcePoints: [
    {
      x: 512,
      y: 288,
      location: {
        coordinates: {
          latitude: 40.007,
          longitude: -105.4,
        },
        scope: "area",
        objectId: "a1220000-0000-4000-8000-000000000002",
        providerId: "mountain-project",
        name: "Boulder Canyon",
      },
    },
  ],
} satisfies ActivityLocation;
