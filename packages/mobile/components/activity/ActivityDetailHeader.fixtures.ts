import type { ComponentProps } from "react";
import { garminActivitySourceTree } from "../../app-fixtures/activity-source-tree";
import type { ActivityDetailHeader } from "./ActivityDetailHeader";

export const detailHeaderActivity: ComponentProps<typeof ActivityDetailHeader>["activity"] = {
  name: "Morning Ride",
  activityType: "cycling",
  primaryActivityType: null,
  displayedDate: "2026-04-14",
  startedAt: "2026-04-14T10:00:00.000Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  providerId: "garmin",
  subsource: null,
  providerAbsentAt: null,
  sourceTree: garminActivitySourceTree,
};

export const removedDetailHeaderActivity: ComponentProps<typeof ActivityDetailHeader>["activity"] =
  {
    ...detailHeaderActivity,
    providerAbsentAt: "2026-03-05T14:30:00.000Z",
    sourceTree: {
      primary: {
        id: "removed-garmin",
        providerId: "garmin",
        sourceName: "Garmin Edge 530",
        label: "Garmin Edge 530",
        description: "Removed from provider sync on March 5, 2026",
        url: null,
        children: [],
      },
      otherSources: [],
    },
  };
