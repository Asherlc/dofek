import type { ComponentProps } from "react";
import type { ActivityDetailHeader } from "../../components/activity/ActivityDetailHeader";
import type { OverviewEvidence } from "../../components/OverviewEvidence";
import { garminActivitySourceTree } from "../activity-source-tree";
import { overviewEvidenceFixture } from "./overview-evidence";

/** Explicit offset so host timezone cannot shift the synthetic capture clock. */
export const SCREENSHOT_CAPTURE_INSTANT = "2026-11-17T12:00:00.000-08:00";
export const SCREENSHOT_TIMEZONE = "America/Los_Angeles";
export const SCREENSHOT_CAPTURE_DATE = "2026-11-17";

/** Morning Ride shared by Activities and heart-rate zone captures (7:30–9:00 AM local). */
export const screenshotMorningRideTiming = {
  startUtcSuffix: "T15:30:00.000Z",
  endUtcSuffix: "T17:00:00.000Z",
  durationMin: 90,
  localTimeContext: {
    timezone: SCREENSHOT_TIMEZONE,
    startUtcOffsetMinutes: -480,
    endUtcOffsetMinutes: -480,
    source: "device_timezone" as const,
  },
} as const;

export const screenshotMorningRideHeader: ComponentProps<typeof ActivityDetailHeader>["activity"] =
  {
    id: "00000000-0000-4000-8000-000000000201",
    name: "Morning Ride",
    activityType: "cycling",
    primaryActivityType: null,
    displayedDate: SCREENSHOT_CAPTURE_DATE,
    startedAt: `${SCREENSHOT_CAPTURE_DATE}${screenshotMorningRideTiming.startUtcSuffix}`,
    climbingLogSessions: [],
    localTimeContext: screenshotMorningRideTiming.localTimeContext,
    providerId: "garmin",
    subsource: null,
    providerAbsentAt: null,
    fitRecoveryWarning: null,
    sourceTree: garminActivitySourceTree,
  };

/** Overview App Store story: no insights, Recovery-aligned monitor readings. */
export const screenshotOverviewEvidence = {
  insights: { isLoading: false, data: [] },
  heartRate: overviewEvidenceFixture.heartRate,
  trends: {
    isLoading: false,
    data: {
      latest_resting_hr: 52,
      restingHeartRateTrendLabel: "below average",
      healthStatus: overviewEvidenceFixture.trends.data.healthStatus.map((metric) => {
        if (metric.metric === "hrv") {
          return {
            ...metric,
            value: 56,
            valueText: "56 ms",
            baseline: 50,
            baselineText: "50 ms",
          };
        }
        if (metric.metric === "sleep_efficiency") {
          return { ...metric, value: 90, baseline: 86 };
        }
        if (metric.metric === "skin_temperature") {
          return {
            ...metric,
            value: 33.8,
            baseline: 33.6,
            deviation: 0.2,
            direction: "above" as const,
            comparison: {
              recentDays: 7,
              baselineDays: 28,
              recentMean: 33.8,
              baselineMean: 33.6,
              delta: 0.2,
              direction: "increasing" as const,
            },
          };
        }
        return metric;
      }),
    },
  },
} satisfies Pick<ComponentProps<typeof OverviewEvidence>, "insights" | "heartRate" | "trends">;

export const screenshotConnectedProviders = [
  {
    id: "garmin",
    name: "Garmin",
    authType: "oauth" as const,
    authorized: true,
    lastSyncedAt: "2026-11-17T17:05:00.000Z",
    importOnly: false,
    needsReauth: false,
  },
  {
    id: "apple_health",
    name: "Apple Health",
    authType: "none" as const,
    authorized: true,
    lastSyncedAt: "2026-11-17T14:30:00.000Z",
    importOnly: false,
    needsReauth: false,
  },
  {
    id: "whoop",
    name: "WHOOP",
    authType: "custom:whoop" as const,
    authorized: true,
    lastSyncedAt: "2026-11-17T14:00:00.000Z",
    importOnly: false,
    needsReauth: false,
  },
];
