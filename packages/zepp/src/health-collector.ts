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

export function workoutHistoryToActivities(history: WorkoutHistoryEntry[]): HealthActivity[] {
  return history.map((historyEntry) => {
    const startedAtMilliseconds = historyEntry.startTime * 1000;
    return {
      externalId: String(historyEntry.startTime),
      activityType: "other",
      startedAt: new Date(startedAtMilliseconds).toISOString(),
      endedAt: new Date(startedAtMilliseconds + historyEntry.duration * 1000).toISOString(),
    };
  });
}

export function collectHealthData(sensors: SensorConstructors): HealthDataPayload {
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
    payload.heartRate = heartRate.getToday();
    payload.restingHeartRate = heartRate.getResting();
    const dailySummary = heartRate.getDailySummary();
    if (dailySummary?.maximum) {
      payload.heartRateSummary = {
        maxHr: dailySummary.maximum.hr_value,
        maxHrTime: dailySummary.maximum.time,
      };
    }
  } catch {
    // HeartRate sensor unavailable
  }

  try {
    const step = new sensors.Step();
    payload.steps = step.getCurrent();
    payload.stepsTarget = step.getTarget();
  } catch {
    // Step sensor unavailable
  }

  try {
    const distance = new sensors.Distance();
    payload.distance = distance.getCurrent();
  } catch {
    // Distance sensor unavailable
  }

  try {
    const sleep = new sensors.Sleep();
    sleep.updateInfo();
    const info = sleep.getInfo();
    if (info && info.totalTime > 0) {
      payload.sleep = {
        score: info.score,
        deepMinutes: info.deepTime,
        startTime: info.startTime,
        endTime: info.endTime,
        totalTime: info.totalTime,
        stages: sleep.getStage(),
      };
    }
    const napData = sleep.getNap();
    if (napData && napData.length > 0) {
      payload.nap = napData;
    }
  } catch {
    // Sleep sensor unavailable
  }

  try {
    const bloodOxygen = new sensors.BloodOxygen();
    const current = bloodOxygen.getCurrent();
    if (current && current.value > 0) {
      payload.bloodOxygenCurrent = current.value;
    }
    payload.bloodOxygenHourly = bloodOxygen.getLastDay();
    const recent = bloodOxygen.getLastFewHour(6);
    if (recent && recent.length > 0) {
      payload.spo2Recent = recent;
    }
  } catch {
    // BloodOxygen sensor unavailable
  }

  try {
    const bodyTemp = new sensors.BodyTemperature();
    const current = bodyTemp.getCurrent();
    if (current && current.current > 0) {
      payload.bodyTemperatureCurrent = current.current;
    }
    payload.bodyTemperature = bodyTemp.getToday();
  } catch {
    // BodyTemperature sensor unavailable
  }

  try {
    const stress = new sensors.Stress();
    payload.stress = stress.getToday();
    payload.stressByHour = stress.getTodayByHour();
    payload.stressWeekly = stress.getLastWeek();
  } catch {
    // Stress sensor unavailable
  }

  try {
    const stand = new sensors.Stand();
    payload.standHours = stand.getCurrent();
  } catch {
    // Stand sensor unavailable
  }

  try {
    const pai = new sensors.Pai();
    payload.pai = pai.getCurrent();
  } catch {
    // Pai sensor unavailable
  }

  try {
    const fatBurning = new sensors.FatBurning();
    payload.fatBurning = fatBurning.getCurrent();
  } catch {
    // FatBurning sensor unavailable
  }

  try {
    const workout = new sensors.Workout();
    payload.activities = workoutHistoryToActivities(workout.getHistory());
  } catch {
    // Workout sensor unavailable
  }

  return payload;
}
