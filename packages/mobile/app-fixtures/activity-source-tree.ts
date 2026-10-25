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
