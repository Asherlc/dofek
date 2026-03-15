// ============================================================
// Garmin Connect internal API response types
// Reverse-engineered from Garmin Connect web/mobile app
// ============================================================

/** SSO sign-in result */
export interface GarminSsoResult {
  type: "success";
  oauth1Token: string;
  oauth1TokenSecret: string;
  mfaToken?: string;
  oauth2: GarminOAuth2Token;
}

/** SSO MFA challenge */
export interface GarminMfaChallenge {
  type: "mfa_required";
  csrf: string;
  /** Cookies serialized as string to pass back for MFA verification */
  cookies: string;
}

export type GarminSignInResult = GarminSsoResult | GarminMfaChallenge;

/** OAuth2 token from exchange endpoint */
export interface GarminOAuth2Token {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

/** Display name from user profile */
export interface GarminUserProfile {
  displayName: string;
  userName: string;
  profileImageUrl?: string;
}

/** User settings with units, locale, etc. */
export interface GarminUserSettings {
  displayName: string;
  locale: string;
  measurementSystem: string;
  timeFormat: string;
  startOfWeek: string;
}

/** Daily summary from usersummary-service */
export interface GarminDailyUserSummary {
  calendarDate: string;
  totalSteps: number;
  totalDistanceMeters: number;
  activeKilocalories: number;
  bmrKilocalories: number;
  restingHeartRate?: number;
  maxHeartRate?: number;
  averageStressLevel?: number;
  maxStressLevel?: number;
  stressDuration?: number;
  restStressDuration?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  bodyBatteryMostRecentValue?: number;
  floorsAscended?: number;
  floorsDescended?: number;
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  totalKilocalories?: number;
}

/** Sleep data from wellness-service */
export interface GarminSleepData {
  dailySleepDTO: {
    calendarDate: string;
    sleepStartTimestampGMT: number;
    sleepEndTimestampGMT: number;
    sleepTimeSeconds: number;
    deepSleepSeconds: number;
    lightSleepSeconds: number;
    remSleepSeconds: number;
    awakeSleepSeconds: number;
    averageSpO2Value?: number;
    lowestSpO2Value?: number;
    averageRespirationValue?: number;
    sleepScores?: {
      qualityScore?: number;
      recoveryScore?: number;
      durationScore?: number;
      overall?: { value: number; qualifierKey: string };
    };
  };
  sleepMovement?: Array<{
    startGMT: string;
    endGMT: string;
    activityLevel: number;
  }>;
  sleepLevels?: Array<{
    startGMT: string;
    endGMT: string;
    activityLevel: number;
  }>;
}

/** Heart rate data from wellness-service */
export interface GarminHeartRateData {
  calendarDate: string;
  startTimestampGMT: number;
  endTimestampGMT: number;
  restingHeartRate: number;
  maxHeartRate: number;
  minHeartRate: number;
  heartRateValues: Array<[number, number | null]>;
}

/** Stress data from wellness-service */
export interface GarminStressData {
  calendarDate: string;
  startTimestampGMT: number;
  endTimestampGMT: number;
  overallStressLevel: number;
  restStressDuration: number;
  activityStressDuration: number;
  lowStressDuration: number;
  mediumStressDuration: number;
  highStressDuration: number;
  stressValuesArray: Array<[number, number]>;
}

/** Body battery from wellness-service */
export interface GarminBodyBatteryData {
  calendarDate: string;
  charged: number;
  drained: number;
  startTimestampGMT: number;
  endTimestampGMT: number;
  bodyBatteryValuesArray: Array<[number, number]>;
}

/** SpO2 from wellness-service */
export interface GarminSpO2Data {
  calendarDate: string;
  averageSpO2: number;
  lowestSpO2: number;
  lastSevenDaysAvgSpO2: number;
  spO2SingleValues?: Array<{
    epochTimestamp: number;
    spo2Reading: number;
  }>;
}

/** HRV data from hrv-service */
export interface GarminHrvData {
  calendarDate: string;
  weeklyAvg?: number;
  lastNight?: number;
  lastNightAvg?: number;
  lastNight5MinHigh?: number;
  baseline?: {
    lowUpper: number;
    balancedLow: number;
    balancedUpper: number;
    markerValue?: number;
  };
  startTimestampGMT?: number;
  endTimestampGMT?: number;
  startTimestampLocal?: number;
  endTimestampLocal?: number;
  hrvSummary?: {
    weeklyAvg?: number;
    lastNight?: number;
    lastNightAvg?: number;
    lastNight5MinHigh?: number;
    status?: string;
  };
}

/** Respiration data from wellness-service */
export interface GarminRespirationData {
  calendarDate: string;
  avgWakingRespirationValue?: number;
  highestRespirationValue?: number;
  lowestRespirationValue?: number;
  avgSleepRespirationValue?: number;
}

/** Activity search result from activitylist-service */
export interface GarminConnectActivity {
  activityId: number;
  activityName: string;
  activityType: {
    typeId: number;
    typeKey: string;
    parentTypeId: number;
    isHidden: boolean;
    sortOrder: number;
  };
  startTimeLocal: string;
  startTimeGMT: string;
  duration: number;
  distance?: number;
  averageHR?: number;
  maxHR?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  calories?: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageBikingCadenceInRevPerMin?: number;
  averageRunningCadenceInStepsPerMin?: number;
  avgPower?: number;
  maxPower?: number;
  normPower?: number;
  trainingStressScore?: number;
  intensityFactor?: number;
  aerobicTrainingEffect?: number;
  anaerobicTrainingEffect?: number;
  vO2MaxValue?: number;
  deviceId?: number;
  hasPolyline?: boolean;
  ownerId?: number;
  ownerDisplayName?: string;
}

/** Training readiness from metrics-service */
export interface GarminTrainingReadiness {
  calendarDate: string;
  score?: number;
  level?: string;
  sleepScore?: number;
  recoveryScore?: number;
  hrvStatus?: string;
  acuteTrainingLoad?: number;
  trainingLoadBalance?: number;
}

/** Training status from metrics-service */
export interface GarminTrainingStatus {
  calendarDate: string;
  trainingStatusName?: string;
  trainingLoad7Day?: number;
  trainingLoad28Day?: number;
  ltss?: number;
  stss?: number;
  sTSB?: number;
}

/** Race predictions from metrics-service */
export interface GarminRacePredictions {
  calendarDate: string;
  race5K?: number;
  race10K?: number;
  raceHalfMarathon?: number;
  raceMarathon?: number;
}

/** Max metrics (VO2max, etc.) */
export interface GarminMaxMetrics {
  calendarDate: string;
  vo2MaxPreciseValue?: number;
  generic?: { vo2MaxPreciseValue?: number; fitnessAge?: number };
  cycling?: { vo2MaxPreciseValue?: number };
}

/** Weight data from weight-service */
export interface GarminWeightEntry {
  samplePk: number;
  date: number;
  calendarDate: string;
  version: number;
  weight: number;
  bmi?: number;
  bodyFat?: number;
  bodyWater?: number;
  boneMass?: number;
  muscleMass?: number;
  physiqueRating?: number;
  visceralFat?: number;
  metabolicAge?: number;
  sourceType?: string;
}

export interface GarminWeightResponse {
  dateWeightList: GarminWeightEntry[];
  totalAverage: { weight: number };
}

/** Fitness age from fitnessage-service */
export interface GarminFitnessAge {
  chronologicalAge: number;
  fitnessAge: number;
  bmiScore: number;
  vigorousMinutesScore: number;
  restingHrScore: number;
  bodyFatScore?: number;
}

/** Endurance score from metrics-service */
export interface GarminEnduranceScore {
  calendarDate: string;
  overallScore?: number;
  currentExhaustionLevel?: number;
}

/** Hill score from metrics-service */
export interface GarminHillScore {
  calendarDate: string;
  overallScore?: number;
  hillStrengthFactor?: number;
  enduranceFactor?: number;
}

/** Intensity minutes from wellness-service */
export interface GarminIntensityMinutes {
  calendarDate: string;
  weeklyGoal: number;
  moderateValue: number;
  vigorousValue: number;
}
