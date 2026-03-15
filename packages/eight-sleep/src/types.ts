export interface EightSleepAuthResponse {
  access_token: string;
  expires_in: number;
  userId: string;
}

export interface EightSleepSleepQualityScore {
  total: number;
  hrv?: { score: number; current: number; average: number };
  respiratoryRate?: { score: number; current: number; average: number };
  heartRate?: { score: number; current: number; average: number };
  tempBedC?: { average: number };
  tempRoomC?: { average: number };
  sleepDurationSeconds?: { score: number };
}

export interface EightSleepSleepStage {
  stage: string; // "awake" | "light" | "deep" | "rem" | "out"
  duration: number; // seconds
}

export interface EightSleepTimeseries {
  heartRate?: Array<[string, number]>;
  tempBedC?: Array<[string, number]>;
  tempRoomC?: Array<[string, number]>;
  respiratoryRate?: Array<[string, number]>;
  hrv?: Array<[string, number]>;
}

export interface EightSleepSession {
  stages: EightSleepSleepStage[];
  timeseries: EightSleepTimeseries;
}

export interface EightSleepTrendDay {
  day: string; // "YYYY-MM-DD"
  score: number;
  tnt: number; // toss & turns
  processing: boolean;
  presenceDuration: number; // seconds
  sleepDuration: number;
  lightDuration: number;
  deepDuration: number;
  remDuration: number;
  latencyAsleepSeconds: number;
  latencyOutSeconds: number;
  presenceStart: string; // ISO datetime
  presenceEnd: string; // ISO datetime
  sleepQualityScore?: EightSleepSleepQualityScore;
  sleepRoutineScore?: {
    total: number;
    latencyAsleepSeconds?: { score: number };
    latencyOutSeconds?: { score: number };
    wakeupConsistency?: { score: number };
  };
  sleepFitnessScore?: { total: number };
  sessions?: EightSleepSession[];
}

export interface EightSleepTrendsResponse {
  days: EightSleepTrendDay[];
}
