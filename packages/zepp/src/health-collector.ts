export interface SleepStage {
  model: number;
  start: number;
  stop: number;
}

export interface NapInfo {
  length: number;
  start: number;
  stop: number;
}

export interface SpO2Reading {
  spo2: number;
  time: number;
}

export interface DailyHeartRateSummary {
  maxHr?: number;
  maxHrTime?: number;
}

export interface WorkoutHistoryEntry {
  startTime: number;
  duration: number;
}

export interface HealthActivity {
  externalId: string;
  activityType: "other";
  startedAt: string;
  endedAt: string;
  raw?: Record<string, unknown>;
}

export interface HealthDataPayload {
  collectedAt: number;
  date: string;
  timezoneOffsetMinutes: number;
  steps?: number;
  stepsTarget?: number;
  distance?: number;
  heartRate?: number[];
  restingHeartRate?: number;
  heartRateSummary?: DailyHeartRateSummary;
  sleep?: {
    score: number;
    deepMinutes: number;
    startTime: number;
    endTime: number;
    totalTime: number;
    stages?: SleepStage[];
  };
  nap?: NapInfo[];
  bloodOxygenCurrent?: number;
  bloodOxygenHourly?: number[];
  spo2Recent?: SpO2Reading[];
  bodyTemperatureCurrent?: number;
  bodyTemperature?: number[];
  stress?: number[];
  stressByHour?: number[];
  stressWeekly?: number[];
  standHours?: number;
  pai?: number;
  fatBurning?: number;
  activities?: HealthActivity[];
  backgroundSamples?: Array<{
    recordedAt: string;
    heartRate?: number;
    bloodOxygenPercent?: number;
    bodyTemperatureCelsius?: number;
    stress?: number;
  }>;
}

export interface SensorConstructors {
  HeartRate: new () => {
    getToday(): number[];
    getResting(): number;
    getDailySummary(): { maximum?: { hr_value: number; time: number } };
    getLast(): number;
  };
  Step: new () => { getCurrent(): number; getTarget(): number };
  Distance: new () => { getCurrent(): number };
  Sleep: new () => {
    updateInfo(): void;
    getInfo(): {
      score: number;
      deepTime: number;
      startTime: number;
      endTime: number;
      totalTime: number;
    };
    getStage(): SleepStage[];
    getNap(): NapInfo[];
  };
  BloodOxygen: new () => {
    getCurrent(): { value: number };
    getLastDay(): number[];
    getLastFewHour(hours: number): SpO2Reading[];
  };
  BodyTemperature: new () => { getCurrent(): { current: number }; getToday(): number[] };
  Stress: new () => {
    getToday(): number[];
    getTodayByHour(): number[];
    getLastWeek(): number[];
  };
  Stand: new () => { getCurrent(): number };
  Pai: new () => { getCurrent(): number };
  FatBurning: new () => { getCurrent(): number };
  Workout: new () => { getHistory(): WorkoutHistoryEntry[] };
}

export type CaptureHealthException = (
  error: unknown,
  context: { operation: "collect"; sensor: keyof SensorConstructors },
) => void;

function finiteNumber(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: number): number | undefined {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveSeries(values: number[]): number[] {
  return values.map((value) => positiveNumber(value) ?? 0);
}

function temperatureSeries(values: number[]): number[] {
  return values.map((value) => {
    const finite = finiteNumber(value);
    return finite !== undefined && finite > -1000 ? finite : -1000;
  });
}

function reportCollectionError(
  captureException: CaptureHealthException,
  sensor: keyof SensorConstructors,
  error: unknown,
): void {
  captureException(error, { operation: "collect", sensor });
}

export function workoutHistoryToActivities(history: WorkoutHistoryEntry[]): HealthActivity[] {
  const activities: HealthActivity[] = [];
  for (const historyEntry of history) {
    const startTime = positiveNumber(historyEntry.startTime);
    const duration = nonNegativeNumber(historyEntry.duration);
    if (startTime === undefined || duration === undefined) {
      continue;
    }
    const startedAtMilliseconds = historyEntry.startTime * 1000;
    const endedAtMilliseconds = startedAtMilliseconds + historyEntry.duration * 1000;
    const startedAt = new Date(startedAtMilliseconds);
    const endedAt = new Date(endedAtMilliseconds);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      continue;
    }
    activities.push({
      externalId: String(historyEntry.startTime),
      activityType: "other",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });
  }
  return activities;
}

export function collectHealthData(
  sensors: SensorConstructors,
  captureException: CaptureHealthException,
): HealthDataPayload {
  const now = Date.now();
  const currentDate = new Date(now);
  const today = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

  const payload: HealthDataPayload = {
    collectedAt: now,
    date: today,
    timezoneOffsetMinutes: currentDate.getTimezoneOffset(),
  };

  try {
    const heartRate = new sensors.HeartRate();
    payload.heartRate = positiveSeries(heartRate.getToday());
    payload.restingHeartRate = positiveNumber(heartRate.getResting());
    const dailySummary = heartRate.getDailySummary();
    const maxHr = dailySummary?.maximum && positiveNumber(dailySummary.maximum.hr_value);
    const maxHrTime = dailySummary?.maximum && nonNegativeInteger(dailySummary.maximum.time);
    if (maxHr !== undefined && maxHrTime !== undefined) {
      payload.heartRateSummary = {
        maxHr,
        maxHrTime,
      };
    }
  } catch (error) {
    reportCollectionError(captureException, "HeartRate", error);
  }

  try {
    const step = new sensors.Step();
    payload.steps = nonNegativeInteger(step.getCurrent());
    payload.stepsTarget = nonNegativeInteger(step.getTarget());
  } catch (error) {
    reportCollectionError(captureException, "Step", error);
  }

  try {
    const distance = new sensors.Distance();
    payload.distance = nonNegativeNumber(distance.getCurrent());
  } catch (error) {
    reportCollectionError(captureException, "Distance", error);
  }

  try {
    const sleep = new sensors.Sleep();
    sleep.updateInfo();
    const info = sleep.getInfo();
    const totalTime = info && positiveNumber(info.totalTime);
    if (info && totalTime !== undefined) {
      const score = nonNegativeNumber(info.score);
      const deepMinutes = nonNegativeNumber(info.deepTime);
      const startTime = nonNegativeNumber(info.startTime);
      const endTime = nonNegativeNumber(info.endTime);
      const stages = sleep
        .getStage()
        .filter(
          (stage) =>
            nonNegativeInteger(stage.model) !== undefined &&
            nonNegativeNumber(stage.start) !== undefined &&
            nonNegativeNumber(stage.stop) !== undefined,
        );
      payload.sleep = {
        score: score ?? 0,
        deepMinutes: deepMinutes ?? 0,
        startTime: startTime ?? 0,
        endTime: endTime ?? 0,
        totalTime,
        stages,
      };
    }
    const napData = sleep.getNap();
    const validNaps = napData?.filter(
      (nap) =>
        positiveNumber(nap.length) !== undefined &&
        nonNegativeNumber(nap.start) !== undefined &&
        nonNegativeNumber(nap.stop) !== undefined,
    );
    if (validNaps && validNaps.length > 0) {
      payload.nap = validNaps;
    }
  } catch (error) {
    reportCollectionError(captureException, "Sleep", error);
  }

  try {
    const bloodOxygen = new sensors.BloodOxygen();
    const current = bloodOxygen.getCurrent();
    const currentValue = current && positiveNumber(current.value);
    if (currentValue !== undefined && currentValue <= 100) {
      payload.bloodOxygenCurrent = currentValue;
    }
    payload.bloodOxygenHourly = bloodOxygen.getLastDay().map((value) => {
      const valid = positiveNumber(value);
      return valid !== undefined && valid <= 100 ? valid : 0;
    });
    const recent = bloodOxygen.getLastFewHour(6);
    const validRecent = recent?.filter(
      (reading) =>
        positiveNumber(reading.spo2) !== undefined &&
        reading.spo2 <= 100 &&
        nonNegativeInteger(reading.time) !== undefined,
    );
    if (validRecent && validRecent.length > 0) {
      payload.spo2Recent = validRecent;
    }
  } catch (error) {
    reportCollectionError(captureException, "BloodOxygen", error);
  }

  try {
    const bodyTemp = new sensors.BodyTemperature();
    const current = bodyTemp.getCurrent();
    const currentValue = current && positiveNumber(current.current);
    if (currentValue !== undefined) {
      payload.bodyTemperatureCurrent = currentValue;
    }
    payload.bodyTemperature = temperatureSeries(bodyTemp.getToday());
  } catch (error) {
    reportCollectionError(captureException, "BodyTemperature", error);
  }

  try {
    const stress = new sensors.Stress();
    payload.stress = positiveSeries(stress.getToday());
    payload.stressByHour = positiveSeries(stress.getTodayByHour());
    payload.stressWeekly = positiveSeries(stress.getLastWeek());
  } catch (error) {
    reportCollectionError(captureException, "Stress", error);
  }

  try {
    const stand = new sensors.Stand();
    payload.standHours = nonNegativeInteger(stand.getCurrent());
  } catch (error) {
    reportCollectionError(captureException, "Stand", error);
  }

  try {
    const pai = new sensors.Pai();
    payload.pai = nonNegativeNumber(pai.getCurrent());
  } catch (error) {
    reportCollectionError(captureException, "Pai", error);
  }

  try {
    const fatBurning = new sensors.FatBurning();
    payload.fatBurning = nonNegativeInteger(fatBurning.getCurrent());
  } catch (error) {
    reportCollectionError(captureException, "FatBurning", error);
  }

  try {
    const workout = new sensors.Workout();
    payload.activities = workoutHistoryToActivities(workout.getHistory());
  } catch (error) {
    reportCollectionError(captureException, "Workout", error);
  }

  return payload;
}
