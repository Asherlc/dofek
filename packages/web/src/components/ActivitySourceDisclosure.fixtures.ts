import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";

export const walkingSourceTree: ActivitySourceTree = {
  primary: {
    id: "apple-record:recording-attribution",
    providerId: "apple-watch",
    sourceName: null,
    label: "Asher’s Apple Watch",
    description: null,
    url: null,
    children: [
      {
        id: "apple-record",
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
      id: "peloton-record",
      providerId: "peloton",
      sourceName: null,
      label: "Peloton",
      description: null,
      url: null,
      children: [],
    },
  ],
};

export const walkingHardware: ActivityHardware = {
  items: [
    {
      id: "apple-watch",
      activityId: "apple-record",
      providerId: "apple_health",
      sourceName: "Asher’s Apple Watch",
      role: "recorder",
      label: "Apple Watch",
      model: null,
      manufacturer: "Apple",
      evidence: "Hardware reported by HealthKit.",
      details: [],
    },
    {
      id: "peloton-device",
      activityId: "peloton-record",
      providerId: "peloton",
      sourceName: null,
      role: "category",
      label: "Whoop",
      model: null,
      manufacturer: null,
      evidence: "Device or platform metadata reported by Peloton.",
      details: [],
    },
  ],
  power: [],
};

export const sourceHardware: ActivityHardware = {
  items: [
    {
      id: "garmin-device",
      activityId: "garmin-record",
      providerId: "garmin",
      sourceName: null,
      role: "recorder",
      label: "Edge 530",
      model: "Edge 530",
      manufacturer: "Garmin",
      evidence: "Recording device reported by Garmin.",
      details: [{ label: "Serial number", value: "12345678" }],
    },
    {
      id: "peloton-metadata",
      activityId: "peloton-record",
      providerId: "peloton",
      sourceName: null,
      role: "category",
      label: "Whoop",
      model: null,
      manufacturer: null,
      evidence: "Device or platform metadata reported by Peloton.",
      details: [],
    },
  ],
  power: [
    {
      activityId: "strava-record",
      providerId: "strava",
      kind: "measured",
      label: "Power · Measured · Strava",
    },
  ],
};

export const branchingSourceTree: ActivitySourceTree = {
  primary: {
    id: "garmin-record",
    providerId: "garmin",
    sourceName: null,
    label: "Garmin Connect",
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
    sourceName: null,
    label: "Strong",
    description: "Recording app reported by Apple Health",
    url: null,
    children: [
      {
        id: "apple-strong-record",
        providerId: "apple_health",
        sourceName: null,
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
    sourceName: null,
    label: "RecordingDeviceWithAnUnbrokenLongName".repeat(3),
    description: "RecordingAttributionWithoutWordBreaks".repeat(3),
    url: null,
    children: [
      {
        id: "long-import",
        providerId: "strava",
        sourceName: null,
        label: "ImportedActivityWithAnUnbrokenLongName".repeat(3),
        description: "TransferDescriptionWithoutWordBreaks".repeat(3),
        url: "https://www.strava.com/activities/123",
        children: [
          {
            id: "long-apple-copy",
            providerId: "apple_health",
            sourceName: null,
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

export const recognizedWatchSourceTree: ActivitySourceTree = {
  primary: {
    id: "apple-run:recording-attribution",
    providerId: "apple-watch",
    sourceName: "Watch6,9",
    label: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
    description: null,
    url: null,
    children: [
      {
        id: "apple-run",
        providerId: "apple_health",
        sourceName: "Workout",
        label: "Apple Health",
        description: null,
        url: null,
        children: [],
      },
    ],
  },
  otherSources: [
    {
      id: "garmin-run",
      providerId: "garmin",
      sourceName: "fr955",
      label: "Garmin Forerunner 955",
      description: null,
      url: "https://connect.garmin.com/modern/activity/955",
      children: [],
    },
  ],
};

export const recognizedWatchHardware: ActivityHardware = {
  items: [
    {
      id: "apple-watch-series-7",
      activityId: "apple-run",
      providerId: "apple_health",
      sourceName: "Workout",
      role: "recorder",
      label: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
      model: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
      manufacturer: "Apple",
      evidence: "Hardware reported by HealthKit.",
      details: [{ label: "Device name", value: "Asher’s Apple Watch" }],
    },
    {
      id: "garmin-forerunner-955",
      activityId: "garmin-run",
      providerId: "garmin",
      sourceName: "fr955",
      role: "recorder",
      label: "Garmin Forerunner 955",
      model: "Garmin Forerunner 955",
      manufacturer: "Garmin",
      evidence: "Recording device reported by Garmin.",
      details: [{ label: "Firmware", value: "19.18" }],
    },
  ],
  power: [],
};
