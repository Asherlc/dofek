import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";

export const branchingActivitySourceTree: ActivitySourceTree = {
  primary: {
    id: "hang-ten",
    providerId: "hang-ten",
    sourceName: null,
    label: "Hang Ten",
    description: null,
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
      description: null,
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
    description: null,
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
      description: null,
      url: null,
      children: [],
    },
  ],
};

export const garminActivitySourceHardware: ActivityHardware = {
  items: [
    {
      id: "edge-recorder",
      activityId: "garmin-record",
      providerId: "garmin",
      sourceName: null,
      role: "recorder",
      label: "Edge 530",
      model: "Edge 530",
      manufacturer: "Garmin",
      evidence: "Recording device reported by Garmin.",
      details: [{ label: "Firmware", value: "9.75" }],
    },
    {
      id: "heart-rate-sensor",
      activityId: "strava-record",
      providerId: "strava",
      sourceName: null,
      role: "sensor",
      label: "HRM-Pro",
      model: "HRM-Pro",
      manufacturer: "Garmin",
      evidence: "Sensor reported in the activity file.",
      details: [{ label: "Battery voltage", value: "2.8 V" }],
    },
    {
      id: "peloton-category",
      activityId: "peloton-record",
      providerId: "peloton",
      sourceName: null,
      role: "category",
      label: "Peloton Bike+",
      model: null,
      manufacturer: null,
      evidence: "Reported equipment category; exact model unavailable.",
      details: [{ label: "Platform", value: "Peloton Bike" }],
    },
  ],
  power: [
    {
      activityId: "strava-record",
      providerId: "strava",
      kind: "measured",
      label: "Strava reports power-meter data.",
    },
  ],
};

export const walkingActivitySourceTree: ActivitySourceTree = {
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

export const walkingActivitySourceHardware: ActivityHardware = {
  items: [
    {
      id: "apple-watch",
      activityId: "apple-record",
      providerId: "apple_health",
      sourceName: "Asher’s Apple Watch",
      role: "recorder",
      label: "Apple Watch",
      model: "Watch",
      manufacturer: "Apple",
      evidence: "Hardware reported by HealthKit.",
      details: [{ label: "Serial number", value: "WATCH-123" }],
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
