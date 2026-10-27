import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";

export const detailSourceTree: ActivitySourceTree = {
  primary: {
    id: "garmin-record",
    providerId: "garmin",
    sourceName: "Garmin Edge 530",
    label: "Garmin Edge 530",
    description: null,
    url: "https://connect.garmin.com/modern/activity/123",
    children: [
      {
        id: "strava-record",
        providerId: "strava",
        sourceName: null,
        label: "Strava",
        description: null,
        url: "https://www.strava.com/activities/123",
        children: [
          {
            id: "apple-strava-record",
            providerId: "apple_health",
            sourceName: null,
            label: "Apple Health",
            description: null,
            url: null,
            children: [],
          },
        ],
      },
      {
        id: "apple-garmin-record",
        providerId: "apple_health",
        sourceName: null,
        label: "Apple Health",
        description: null,
        url: null,
        children: [],
      },
    ],
  },
  otherSources: [
    {
      id: "whoop-record",
      providerId: "whoop",
      sourceName: null,
      label: "WHOOP",
      description: "Other matching source",
      url: null,
      children: [],
    },
  ],
};

export const removedDetailSourceTree: ActivitySourceTree = {
  primary: {
    id: "removed-garmin-record",
    providerId: "garmin",
    sourceName: "Garmin Edge 530",
    label: "Garmin Edge 530",
    description: "Removed from provider",
    url: null,
    children: [
      {
        id: "removed-strava-record",
        providerId: "strava",
        sourceName: null,
        label: "Strava",
        description: "Removed from provider",
        url: null,
        children: [],
      },
    ],
  },
  otherSources: [
    {
      id: "active-whoop-record",
      providerId: "whoop",
      sourceName: null,
      label: "WHOOP",
      description: "Other matching source",
      url: "https://app.whoop.com/activities/123",
      children: [],
    },
  ],
};
