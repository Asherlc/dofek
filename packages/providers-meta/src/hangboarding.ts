export interface HangboardingIntervalDetail {
  id: string;
  intervalIndex: number;
  label: string | null;
  intervalType: "work" | "rest" | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface HangboardingDetail {
  planName: string | null;
  sessionId: string | null;
  boardId: string | null;
  boardName: string | null;
  segmentsError: string | null;
  intervals: HangboardingIntervalDetail[];
}

export interface HangboardingSummary {
  sessionCount: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number | null;
  totalWorkDurationSeconds: number | null;
  totalRestDurationSeconds: number | null;
  workIntervalCount: number | null;
  averageHeartRate: number | null;
  peakHeartRate: number | null;
  latestSession: {
    activityId: string;
    startedAt: string;
    planName: string | null;
    boardName: string | null;
    durationSeconds: number;
  } | null;
  daily: Array<{
    date: string;
    sessionCount: number;
    durationSeconds: number;
    workDurationSeconds: number | null;
    restDurationSeconds: number | null;
  }>;
}
