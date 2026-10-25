import type { ActivityHardware } from "@dofek/providers/activity-hardware";

export const recognizedWatches: ActivityHardware = {
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
      details: [
        { label: "Device name", value: "Asher’s Apple Watch" },
        { label: "Software", value: "26.6" },
      ],
    },
    {
      id: "garmin-forerunner-955",
      activityId: "garmin-run",
      providerId: "garmin",
      sourceName: null,
      role: "recorder",
      label: "Garmin Forerunner 955",
      model: "Garmin Forerunner 955",
      manufacturer: "Garmin",
      evidence: "Recording device reported by Garmin.",
      details: [{ label: "Firmware", value: "21.19" }],
    },
  ],
  power: [],
};
