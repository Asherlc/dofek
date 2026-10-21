import { z } from "zod";
import type { WebhookEvent } from "../types.ts";

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const timestamp = z.number().nonnegative();
const duration = z.number().int().nonnegative();
const optionalNumber = z.number().nullish();
const offsetReadings = z.record(z.string().regex(/^\d+(?:\.\d+)?$/), z.number());
const activityIdentifier = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9]\d*$/),
]);

const summaryShape = {
  userId: identifier,
  summaryId: identifier,
  startTimeInSeconds: timestamp,
  startTimeOffsetInSeconds: z.number().int().optional(),
  durationInSeconds: duration,
};

export const garminDailySchema = z.looseObject({
  ...summaryShape,
  calendarDate: z.iso.date(),
  steps: optionalNumber,
  distanceInMeters: optionalNumber,
  floorsClimbed: optionalNumber,
  activeTimeInSeconds: optionalNumber,
  moderateIntensityDurationInSeconds: optionalNumber,
  vigorousIntensityDurationInSeconds: optionalNumber,
  restingHeartRateInBeatsPerMinute: optionalNumber,
  minHeartRateInBeatsPerMinute: optionalNumber,
  maxHeartRateInBeatsPerMinute: optionalNumber,
  timeOffsetHeartRateSamples: offsetReadings.optional(),
});

const sleepRangeSchema = z
  .looseObject({
    startTimeInSeconds: timestamp,
    endTimeInSeconds: timestamp,
  })
  .refine((range) => range.endTimeInSeconds > range.startTimeInSeconds, {
    message: "Sleep stage must end after it starts",
  });

export const garminSleepSchema = z.looseObject({
  ...summaryShape,
  calendarDate: z.iso.date(),
  validation: z.string().optional(),
  deepSleepDurationInSeconds: optionalNumber,
  lightSleepDurationInSeconds: optionalNumber,
  remSleepInSeconds: optionalNumber,
  awakeDurationInSeconds: optionalNumber,
  unmeasurableSleepInSeconds: optionalNumber,
  unmeasurableSleepDurationInSeconds: optionalNumber,
  sleepLevelsMap: z.record(z.string(), z.array(sleepRangeSchema)).optional(),
  timeOffsetSleepRespiration: offsetReadings.optional(),
  timeOffsetSleepSpo2: offsetReadings.optional(),
});

export const garminHrvSchema = z.looseObject({
  ...summaryShape,
  calendarDate: z.iso.date(),
  lastNightAvg: optionalNumber,
  lastNight5MinHigh: optionalNumber,
  hrvValues: offsetReadings.optional(),
});

export const garminPulseOxSchema = z.looseObject({
  ...summaryShape,
  calendarDate: z.iso.date(),
  onDemand: z.boolean().optional(),
  timeOffsetSpo2Values: offsetReadings.optional(),
});

export const garminRespirationSchema = z.looseObject({
  ...summaryShape,
  timeOffsetEpochToBreaths: offsetReadings.optional(),
});

const activityShape = {
  ...summaryShape,
  activityType: identifier,
  activityName: z.string().optional(),
  distanceInMeters: optionalNumber,
  averageHeartRateInBeatsPerMinute: optionalNumber,
  maxHeartRateInBeatsPerMinute: optionalNumber,
  manual: z.boolean().optional(),
};

export const garminActivitySchema = z.looseObject({
  ...activityShape,
  activityId: activityIdentifier,
});

export const garminManualActivitySchema = z.looseObject({
  ...activityShape,
  activityId: activityIdentifier.optional(),
});

const activityCallback = z.string().refine(
  (value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "apis.garmin.com" &&
      url.port === "" &&
      url.pathname === "/wellness-api/rest/activityFile" &&
      !url.username &&
      !url.password &&
      !value.includes("#")
    );
  },
  { message: "Garmin activity callback must use the official HTTPS activityFile endpoint" },
);

export const garminActivityFileSchema = z.looseObject({
  userId: identifier,
  summaryId: identifier,
  activityId: activityIdentifier,
  activityType: identifier,
  activityName: z.string().optional(),
  startTimeInSeconds: timestamp,
  fileType: z.enum(["FIT", "TCX", "GPX"]),
  callbackURL: activityCallback,
  manual: z.boolean().optional(),
});

const deregistrationSchema = z.looseObject({ userId: identifier });
const permissionChangeSchema = z.looseObject({
  userId: identifier,
  summaryId: identifier,
  permissions: z.array(identifier),
  changeTimeInSeconds: timestamp,
});

const webhookSchema = z
  .object({
    dailies: z.array(garminDailySchema).optional(),
    sleeps: z.array(garminSleepSchema).optional(),
    hrv: z.array(garminHrvSchema).optional(),
    pulseox: z.array(garminPulseOxSchema).optional(),
    allDayRespiration: z.array(garminRespirationSchema).optional(),
    activities: z.array(garminActivitySchema).optional(),
    activityFiles: z.array(garminActivityFileSchema).optional(),
    manuallyUpdatedActivities: z.array(garminManualActivitySchema).optional(),
    deregistrations: z.array(deregistrationSchema).optional(),
    userPermissionsChange: z.array(permissionChangeSchema).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Garmin notification must contain a supported feed",
  });

export function parseGarminWebhookPayload(body: unknown): WebhookEvent[] {
  const parsed = webhookSchema.parse(body);
  const events: WebhookEvent[] = [];
  for (const [family, records] of Object.entries(parsed)) {
    for (const record of records ?? []) {
      const objectId =
        "activityId" in record && record.activityId !== undefined
          ? String(record.activityId)
          : "summaryId" in record && typeof record.summaryId === "string"
            ? record.summaryId
            : record.userId;
      events.push({
        ownerExternalId: record.userId,
        eventType: family === "deregistrations" ? "delete" : "update",
        objectType: family,
        objectId,
        metadata: { payload: record },
      });
    }
  }
  return events;
}
