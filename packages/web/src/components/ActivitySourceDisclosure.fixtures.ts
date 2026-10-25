import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";

export const branchingSourceTree: ActivitySourceTree = {
  primary: {
    id: "garmin-record",
    providerId: "garmin",
    label: "Garmin Connect",
    description: "Closest available recording",
    url: "https://connect.garmin.com/modern/activity/123",
    children: [
      {
        id: "strava-record",
        providerId: "strava",
        label: "Strava",
        description: "Imported from Garmin Connect",
        url: "https://www.strava.com/activities/123",
        children: [
          {
            id: "apple-strava-record",
            providerId: "apple_health",
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
      label: "WHOOP",
      description: "Transfer history unavailable",
      url: null,
      children: [],
    },
  ],
};

export const strongSourceTree: ActivitySourceTree = {
  primary: {
    id: "strong-record",
    providerId: "strong-csv",
    label: "Strong",
    description: "Recording app reported by Apple Health",
    url: null,
    children: [
      {
        id: "apple-strong-record",
        providerId: "apple_health",
        label: "Apple Health",
        description: "Recorded by Strong",
        url: null,
        children: [],
      },
    ],
  },
  otherSources: [],
};

export const longSourceTree: ActivitySourceTree = {
  primary: {
    id: "long-recording",
    providerId: "garmin",
    label: "RecordingDeviceWithAnUnbrokenLongName".repeat(3),
    description: "RecordingAttributionWithoutWordBreaks".repeat(3),
    url: null,
    children: [
      {
        id: "long-import",
        providerId: "strava",
        label: "ImportedActivityWithAnUnbrokenLongName".repeat(3),
        description: "TransferDescriptionWithoutWordBreaks".repeat(3),
        url: "https://www.strava.com/activities/123",
        children: [
          {
            id: "long-apple-copy",
            providerId: "apple_health",
            label: "UnknownRecordingAppWithAnUnbrokenLongDeviceName".repeat(3),
            description: "ImportedSourceDescriptionWithoutWordBreaks".repeat(3),
            url: null,
            children: [],
          },
        ],
      },
    ],
  },
  otherSources: [],
};
