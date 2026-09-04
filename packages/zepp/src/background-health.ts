import { appendOutboxEntry, type DurableOutbox } from "./durable-outbox.ts";
import { type HealthActivity, workoutHistoryToActivities } from "./health-collector.ts";

const MAX_BACKGROUND_MINUTE_SAMPLES = 7 * 24 * 60;

export interface BackgroundHealthSample {
  recordedAt: string;
  heartRate?: number;
  bloodOxygenPercent?: number;
  bodyTemperatureCelsius?: number;
  stress?: number;
}

export interface BackgroundHealthBuffer {
  samples: BackgroundHealthSample[];
  activities: HealthActivity[];
}

export type BackgroundHealthEvent =
  | { kind: "sample"; sample: BackgroundHealthSample }
  | { kind: "activity"; activity: HealthActivity };

export type BackgroundHealthOutbox = DurableOutbox<BackgroundHealthEvent>;

interface BackgroundHealthDependencies {
  captureException(error: unknown): void;
  HeartRate: new () => { getLast(): number };
  BloodOxygen: new () => { getCurrent(): { value: number } };
  BodyTemperature: new () => { getCurrent(): { current: number } };
  Stress: new () => { getToday(): number[] };
  Workout: new () => { getHistory(): Array<{ startTime: number; duration: number }> };
}

export function collectBackgroundHealthSample(
  sensors: BackgroundHealthDependencies,
  now = Date.now(),
): { sample: BackgroundHealthSample; activities: HealthActivity[] } {
  const sample: BackgroundHealthSample = { recordedAt: new Date(now).toISOString() };

  try {
    const heartRate = new sensors.HeartRate().getLast();
    if (Number.isFinite(heartRate) && heartRate > 0) sample.heartRate = heartRate;
  } catch (error) {
    sensors.captureException(error);
  }

  try {
    const bloodOxygenPercent = new sensors.BloodOxygen().getCurrent().value;
    if (
      Number.isFinite(bloodOxygenPercent) &&
      bloodOxygenPercent > 0 &&
      bloodOxygenPercent <= 100
    ) {
      sample.bloodOxygenPercent = bloodOxygenPercent;
    }
  } catch (error) {
    sensors.captureException(error);
  }

  try {
    const bodyTemperatureCelsius = new sensors.BodyTemperature().getCurrent().current;
    if (Number.isFinite(bodyTemperatureCelsius) && bodyTemperatureCelsius > 0) {
      sample.bodyTemperatureCelsius = bodyTemperatureCelsius;
    }
  } catch (error) {
    sensors.captureException(error);
  }

  try {
    const stressReadings = new sensors.Stress().getToday();
    for (let index = stressReadings.length - 1; index >= 0; index -= 1) {
      const stress = stressReadings[index];
      if (stress !== undefined && Number.isFinite(stress) && stress > 0) {
        sample.stress = stress;
        break;
      }
    }
  } catch (error) {
    sensors.captureException(error);
  }

  let activities: HealthActivity[] = [];
  try {
    activities = workoutHistoryToActivities(new sensors.Workout().getHistory());
  } catch (error) {
    sensors.captureException(error);
  }

  return { sample, activities };
}

export function appendBackgroundHealthEvents(
  outbox: BackgroundHealthOutbox,
  collected: { sample?: BackgroundHealthSample; activities: HealthActivity[] },
  installId: string,
): BackgroundHealthOutbox {
  if (!installId.trim()) {
    throw new Error("A stable install ID is required for background health events.");
  }

  let updated = outbox;
  if (collected.sample) {
    updated = appendOutboxEntry(updated, {
      eventId: `${installId}:background-sample:${collected.sample.recordedAt}`,
      createdAt: collected.sample.recordedAt,
      payload: { kind: "sample", sample: collected.sample },
      attempts: 0,
    });
  }
  for (const activity of collected.activities) {
    updated = appendOutboxEntry(updated, {
      eventId: `${installId}:activity:${activity.externalId}:${activity.endedAt}`,
      createdAt: activity.endedAt,
      payload: { kind: "activity", activity },
      attempts: 0,
    });
  }

  const samples = updated.pending.filter((entry) => entry.payload.kind === "sample");
  const overflow = samples.length - MAX_BACKGROUND_MINUTE_SAMPLES;
  if (overflow <= 0) {
    return updated;
  }
  const expiredEventIds = new Set(samples.slice(0, overflow).map((entry) => entry.eventId));
  return {
    ...updated,
    pending: updated.pending.filter((entry) => !expiredEventIds.has(entry.eventId)),
  };
}
