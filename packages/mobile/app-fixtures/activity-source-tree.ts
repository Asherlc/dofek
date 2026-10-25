import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";

export const branchingActivitySourceTree: ActivitySourceTree = {
  primary: {
    id: "hang-ten",
    providerId: "hang-ten",
    sourceName: null,
    label: "Hang Ten",
    description: "Recording app reported by Apple Health",
    url: null,
    children: [
      {
        id: "apple-health",
        providerId: "apple_health",
        sourceName: null,
        label: "Apple Health",
        description: "Imported from Hang Ten",
        url: null,
        children: [
          {
            id: "strava-health",
            providerId: "strava",
            sourceName: null,
            label: "Strava",
            description: "Imported from Apple Health",
            url: "https://www.strava.com/activities/123",
            children: [],
          },
        ],
      },
      {
        id: "strava-direct",
        providerId: "strava",
        sourceName: null,
        label: "Strava",
        description: "Imported from Hang Ten",
        url: "https://www.strava.com/activities/456",
        children: [],
      },
    ],
  },
  otherSources: [
    {
      id: "whoop",
      providerId: "whoop",
      sourceName: null,
      label: "WHOOP",
      description: "No confirmed transfer path",
      url: null,
      children: [],
    },
  ],
};

export const garminActivitySourceTree: ActivitySourceTree = {
  primary: {
    id: "garmin-record",
    providerId: "garmin",
    sourceName: "Garmin Edge 530",
    label: "Garmin Edge 530",
    description: "Closest available recording",
    url: "https://connect.garmin.com/modern/activity/123",
    children: [
      {
        id: "strava-record",
        providerId: "strava",
        sourceName: null,
        label: "Strava",
        description: "Imported from Garmin Connect",
        url: "https://www.strava.com/activities/123",
        children: [
          {
            id: "apple-strava-record",
            providerId: "apple_health",
            sourceName: null,
            label: "Apple Health",
            description: "Imported from Strava",
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
        description: "Imported from Garmin Connect",
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
