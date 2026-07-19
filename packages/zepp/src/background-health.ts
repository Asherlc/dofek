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

interface BackgroundHealthDependencies {
  captureException(error: unknown): void;
  HeartRate: new () => { getLast(): number };
  BloodOxygen: new () => { getCurrent(): { value: number } };
  BodyTemperature: new () => { getCurrent(): { current: number } };
  Stress: new () => { getToday(): number[] };
  Workout: new () => { getHistory(): Array<{ startTime: number; duration: number }> };
}

export function emptyBackgroundHealthBuffer(): BackgroundHealthBuffer {
  return { samples: [], activities: [] };
}

export function collectBackgroundHealthSample(
  sensors: BackgroundHealthDependencies,
  now = Date.now(),
): { sample: BackgroundHealthSample; activities: HealthActivity[] } {
  const sample: BackgroundHealthSample = { recordedAt: new Date(now).toISOString() };

  try {
    const heartRate = new sensors.HeartRate().getLast();
    if (heartRate > 0) sample.heartRate = heartRate;
  } catch (error) {
    sensors.captureException(error);
  }

  try {
    const bloodOxygenPercent = new sensors.BloodOxygen().getCurrent().value;
    if (bloodOxygenPercent > 0) sample.bloodOxygenPercent = bloodOxygenPercent;
  } catch (error) {
    sensors.captureException(error);
  }

  try {
    const bodyTemperatureCelsius = new sensors.BodyTemperature().getCurrent().current;
    if (bodyTemperatureCelsius > 0) sample.bodyTemperatureCelsius = bodyTemperatureCelsius;
  } catch (error) {
    sensors.captureException(error);
  }

  try {
    const stressReadings = new sensors.Stress().getToday();
    for (let index = stressReadings.length - 1; index >= 0; index -= 1) {
      const stress = stressReadings[index];
      if (stress !== undefined && stress > 0) {
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

export function appendBackgroundHealthSample(
  buffer: BackgroundHealthBuffer,
  collected: { sample: BackgroundHealthSample; activities: HealthActivity[] },
): BackgroundHealthBuffer {
  const activitiesByExternalId = new Map(
    [...buffer.activities, ...collected.activities].map((activity) => [
      activity.externalId,
      activity,
    ]),
  );
  return {
    samples: [...buffer.samples, collected.sample].slice(-MAX_BACKGROUND_MINUTE_SAMPLES),
    activities: [...activitiesByExternalId.values()],
  };
}
