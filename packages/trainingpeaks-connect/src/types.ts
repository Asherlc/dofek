// ============================================================
// TrainingPeaks internal API response types
// Reverse-engineered from app.trainingpeaks.com
// ============================================================

/** Token response from /users/v3/token */
export interface TrainingPeaksTokenResponse {
  success: boolean;
  token: {
    access_token: string;
    expires_in: number;
  };
}

/** User profile from /users/v3/user */
export interface TrainingPeaksUser {
  user: {
    personId: number;
    firstName: string;
    lastName: string;
    email: string;
    athletes: Array<{ athleteId: number }>;
    settings: {
      account: {
        isPremium: boolean;
      };
    };
  };
}

/** Workout from /fitness/v6/athletes/{id}/workouts */
export interface TrainingPeaksWorkout {
  workoutId: number;
  athleteId: number;
  workoutDay: string;
  title: string;
  description?: string;
  completed: boolean;
  workoutTypeFamilyId: number;
  workoutTypeValueId: number;

  // Time (decimal hours)
  totalTimePlanned?: number;
  totalTime?: number;

  // Distance (meters)
  distancePlanned?: number;
  distance?: number;

  // TSS
  tssPlanned?: number;
  tssActual?: number;
  tssCalculationMethod?: string;

  // Intensity Factor
  ifPlanned?: number;
  if?: number;

  // Power (watts)
  powerAverage?: number;
  normalizedPowerActual?: number;

  // Heart rate (bpm)
  heartRateAverage?: number;
  heartRateMaximum?: number;

  // Cadence
  cadenceAverage?: number;

  // Elevation (meters)
  elevationGain?: number;
  elevationLoss?: number;

  // Other
  calories?: number;
  feeling?: number;
  rpe?: number;
  coachComments?: string;
  athleteComments?: string;
  startTime?: string;
  startTimePlanned?: string;
  lastModifiedDate?: string;
  tags?: string[];
  workoutFileFormats?: string[];
}

/** Performance Management Chart data point */
export interface TrainingPeaksPmcEntry {
  workoutDay: string;
  tssActual: number;
  ctl: number;
  atl: number;
  tsb: number;
}

/** PMC request body */
export interface TrainingPeaksPmcRequest {
  atlConstant: number;
  atlStart: number;
  ctlConstant: number;
  ctlStart: number;
  workoutTypes: number[];
}

/** Personal record entry */
export interface TrainingPeaksPersonalRecord {
  workoutId: number;
  workoutDay: string;
  title: string;
  value: number;
  rank: number;
  duration?: number;
  distance?: number;
}

/** Calendar note */
export interface TrainingPeaksCalendarNote {
  id: number;
  athleteId: number;
  date: string;
  title: string;
  description?: string;
}

/** Workout analysis response from api.peakswaresb.com */
export interface TrainingPeaksWorkoutAnalysis {
  totals: {
    duration?: number;
    distance?: number;
    calories?: number;
    tss?: number;
    normalizedPower?: number;
    intensityFactor?: number;
    averagePower?: number;
    averageHeartRate?: number;
    averageCadence?: number;
    elevationGain?: number;
    work?: number;
  };
  channels?: TrainingPeaksDataChannel[];
  laps?: TrainingPeaksLapData[];
}

/** Time-series data channel */
export interface TrainingPeaksDataChannel {
  name: string;
  min: number;
  max: number;
  avg: number;
  zones?: Array<{
    start: number;
    end: number;
    duration: number;
  }>;
}

/** Lap data */
export interface TrainingPeaksLapData {
  lapNumber: number;
  duration: number;
  distance?: number;
  averagePower?: number;
  normalizedPower?: number;
  averageHeartRate?: number;
  averageCadence?: number;
  elevationGain?: number;
}
