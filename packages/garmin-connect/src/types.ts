// ============================================================
// Authentication types
// ============================================================

export interface OAuthConsumer {
  consumer_key: string;
  consumer_secret: string;
}

export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string;
  mfa_expiration_timestamp?: string;
}

export interface OAuth2Token {
  scope: string;
  jti: string;
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  refresh_token_expires_in: number;
  refresh_token_expires_at: number;
}

export interface GarminTokens {
  oauth1: OAuth1Token;
  oauth2: OAuth2Token;
}

// ============================================================
// User profile
// ============================================================

export interface GarminUserProfile {
  displayName: string;
  userName: string;
  profileImageUrl?: string;
}

// ============================================================
// Daily summary (internal Connect API)
// ============================================================

export interface ConnectDailySummary {
  calendarDate: string;
  totalSteps: number;
  totalDistanceMeters: number;
  activeKilocalories: number;
  bmrKilocalories: number;
  restingHeartRate?: number;
  maxHeartRate?: number;
  averageStressLevel?: number;
  maxStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  bodyBatteryMostRecentValue?: number;
  averageSpo2?: number;
  lowestSpo2?: number;
  latestSpo2?: number;
  averageMonitoringEnvironmentAltitude?: number;
  floorsAscended?: number;
  floorsDescended?: number;
  minAvgHeartRate?: number;
  maxAvgHeartRate?: number;
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  totalKilocalories?: number;
  measurableAwakeDuration?: number;
  measurableAsleepDuration?: number;
  lastSevenDaysAvgRestingHeartRate?: number;
  stressDuration?: number;
  restStressDuration?: number;
  activityStressDuration?: number;
  lowStressDuration?: number;
  mediumStressDuration?: number;
  highStressDuration?: number;
  wellnessStartTimeGMT?: string;
  wellnessEndTimeGMT?: string;
  wellnessStartTimeLocal?: string;
  wellnessEndTimeLocal?: string;
  privacyProtected: boolean;
}

// ============================================================
// Training status & readiness
// ============================================================

export interface TrainingStatus {
  userId: number;
  trainingStatusMessage?: string;
  latestTrainingLoad?: number;
  acuteTrainingLoad?: number;
  chronicTrainingLoad?: number;
  trainingLoadBalance?: number;
  trainingLoadRatio?: number;
  currentDayLoad?: number;
  timestamp?: string;
  aggregatedTrainingLoad?: number;
  latestVo2Max?: number;
  latestVo2MaxCycling?: number;
  latestRunVo2Max?: number;
  latestCycleVo2Max?: number;
  fitnessAge?: number;
  latestFitnessAge?: number;
}

export interface TrainingReadiness {
  calendarDate: string;
  deviceId?: number;
  score?: number;
  level?: string;
  sleepScore?: number;
  recoveryScore?: number;
  acuteTrainingLoadScore?: number;
  hrvScore?: number;
  sleepHistoryScore?: number;
  stressHistoryScore?: number;
  trainingLoadBalanceScore?: number;
}

// ============================================================
// Body battery
// ============================================================

export interface BodyBatteryEvent {
  eventType: string;
  startTimestampGMT?: string;
  endTimestampGMT?: string;
  startTimestampLocal?: string;
  endTimestampLocal?: string;
  timedDuration?: string;
  bodyBatteryImpact?: number;
  activityName?: string;
  activityType?: string;
}

export interface BodyBatteryDay {
  date: string;
  charged: number;
  drained: number;
  startTimestampGMT?: string;
  endTimestampGMT?: string;
  startTimestampLocal?: string;
  endTimestampLocal?: string;
  bodyBatteryStatList?: Array<{
    statsType: string;
    startTimestampGMT: string;
    endTimestampGMT: string;
    startTimestampLocal: string;
    endTimestampLocal: string;
    bodyBatteryLevel?: number;
  }>;
}

// ============================================================
// Stress
// ============================================================

export interface StressDataPoint {
  timestampGMT: string;
  timestampLocal: string;
  stressLevel: number;
}

export interface DailyStress {
  calendarDate: string;
  startTimestampGMT?: string;
  endTimestampGMT?: string;
  startTimestampLocal?: string;
  endTimestampLocal?: string;
  maxStressLevel: number;
  avgStressLevel: number;
  stressChartValueOffset?: number;
  stressChartYAxisOrigin?: number;
  stressValuesArray?: Array<[number, number]>;
  bodyBatteryValuesArray?: Array<[number, number]>;
}

// ============================================================
// HRV (Heart Rate Variability)
// ============================================================

export interface HrvSummary {
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
  startTimestampGMT?: string;
  endTimestampGMT?: string;
  startTimestampLocal?: string;
  endTimestampLocal?: string;
  createTimeStamp?: string;
  status?: string;
  hrvs?: Array<{
    hrvValue?: number;
    readingTimeGMT?: string;
    readingTimeLocal?: string;
    status?: string;
  }>;
}

// ============================================================
// Heart rate
// ============================================================

export interface DailyHeartRate {
  userProfilePK: number;
  calendarDate: string;
  startTimestampGMT: string;
  endTimestampGMT: string;
  startTimestampLocal: string;
  endTimestampLocal: string;
  maxHeartRate: number;
  minHeartRate: number;
  restingHeartRate: number;
  lastSevenDaysAvgRestingHeartRate: number;
  heartRateValues?: Array<[number, number | null]>;
  heartRateValueDescriptors?: Array<{
    key: string;
    index: number;
  }>;
}

// ============================================================
// Sleep (internal, more granular than official)
// ============================================================

export interface ConnectSleepData {
  dailySleepDTO: {
    id: number;
    userProfilePK: number;
    calendarDate: string;
    sleepTimeSeconds?: number;
    napTimeSeconds?: number;
    sleepStartTimestampGMT?: number;
    sleepEndTimestampGMT?: number;
    sleepStartTimestampLocal?: number;
    sleepEndTimestampLocal?: number;
    deepSleepSeconds?: number;
    lightSleepSeconds?: number;
    remSleepSeconds?: number;
    awakeSleepSeconds?: number;
    averageSpO2Value?: number;
    lowestSpO2Value?: number;
    highestSpO2Value?: number;
    averageSpO2HRSleep?: number;
    averageRespirationValue?: number;
    lowestRespirationValue?: number;
    highestRespirationValue?: number;
    awakeningCount?: number;
    sleepScores?: {
      totalDuration?: { value?: number; qualifierKey?: string };
      stress?: { value?: number; qualifierKey?: string };
      awakenings?: { value?: number; qualifierKey?: string };
      overall?: { value?: number; qualifierKey?: string };
      rem?: { value?: number; qualifierKey?: string };
      restfulness?: { value?: number; qualifierKey?: string };
      quality?: { value?: number; qualifierKey?: string };
      light?: { value?: number; qualifierKey?: string };
      deep?: { value?: number; qualifierKey?: string };
    };
    autoSleepStartTimestampGMT?: number;
    autoSleepEndTimestampGMT?: number;
    sleepQualityTypePK?: number;
    sleepResultTypePK?: number;
  };
  sleepMovement?: Array<{
    startGMT: string;
    endGMT: string;
    activityLevel: number;
  }>;
  remSleepData?: Array<{
    startGMT: string;
    endGMT: string;
  }>;
  sleepLevels?: Array<{
    startGMT: string;
    endGMT: string;
    activityLevel: number;
  }>;
  sleepRestlessMoments?: Array<{
    value: number;
    startGMT: number;
  }>;
  wellnessEpochSPO2DataDTOList?: Array<{
    epochTimestamp: number;
    spo2Value: number;
    deviceId: number;
  }>;
  wellnessEpochRespirationDataDTOList?: Array<{
    startTimeGMT: number;
    respirationValue: number;
  }>;
}

// ============================================================
// Activities (internal, with detail streams)
// ============================================================

export interface ConnectActivitySummary {
  activityId: number;
  activityName: string;
  activityType: {
    typeId: number;
    typeKey: string;
    parentTypeId?: number;
    isHidden?: boolean;
    restricted?: boolean;
    trpieable?: boolean;
  };
  startTimeGMT: string;
  startTimeLocal: string;
  distance?: number;
  duration: number;
  elapsedDuration?: number;
  movingDuration?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  averageHR?: number;
  maxHR?: number;
  averageBikingCadenceInRevPerMin?: number;
  averageRunningCadenceInStepsPerMin?: number;
  averagePower?: number;
  maxPower?: number;
  normPower?: number;
  calories?: number;
  elevationGain?: number;
  elevationLoss?: number;
  vO2MaxValue?: number;
  lactateThreshold?: number;
  deviceId?: number;
  startLatitude?: number;
  startLongitude?: number;
  endLatitude?: number;
  endLongitude?: number;
  locationName?: string;
  lapCount?: number;
  hasPolyline?: boolean;
  ownerId?: number;
  ownerDisplayName?: string;
  ownerFullName?: string;
  minTemperature?: number;
  maxTemperature?: number;
  trainingEffect?: number;
  anaerobicTrainingEffect?: number;
  aerobicTrainingEffectMessage?: string;
  anaerobicTrainingEffectMessage?: string;
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  manualActivity?: boolean;
  pr?: boolean;
}

export interface ConnectActivityDetail {
  activityId: number;
  measurementCount: number;
  metricsCount: number;
  metricDescriptors: Array<{
    metricsIndex: number;
    key: string;
    unit?: {
      id: number;
      key: string;
    };
  }>;
  activityDetailMetrics: Array<{
    metrics: Array<number | null>;
  }>;
  geoPolylineDTO?: {
    startPoint: { lat: number; lon: number; altitude?: number };
    endPoint: { lat: number; lon: number; altitude?: number };
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
    polyline: Array<{
      lat: number;
      lon: number;
      altitude?: number;
      time?: number;
      timerStart?: boolean;
      timerStop?: boolean;
      distanceFromPreviousPoint?: number;
      distanceInMeters?: number;
      cumulativeAscent?: number;
      cumulativeDescent?: number;
      speed?: number;
      cumulativeDistance?: number;
    }>;
  };
  heartRateDTOs?: Array<{
    heartRate: number;
    dateTime: string;
  }>;
}

// ============================================================
// Metrics & scores
// ============================================================

export interface Vo2MaxMetric {
  calendarDate: string;
  vo2MaxPreciseValue?: number;
  fitnessAge?: number;
  vo2MaxRunning?: number;
  vo2MaxCycling?: number;
}

export interface RacePrediction {
  calendarDate: string;
  raceTime5K?: number;
  raceTime10K?: number;
  raceTimeHalf?: number;
  raceTimeMarathon?: number;
}

export interface HillScore {
  calendarDate: string;
  overallScore?: number;
  adjustedScore?: number;
  hillScoreZones?: Array<{
    zone: string;
    score: number;
  }>;
}

export interface EnduranceScore {
  calendarDate: string;
  overallScore?: number;
  adjustedScore?: number;
  enduranceScoreZones?: Array<{
    zone: string;
    score: number;
  }>;
}

// ============================================================
// Respiration & SpO2
// ============================================================

export interface DailyRespiration {
  startTimeGMT: number;
  endTimeGMT: number;
  startTimeLocal: number;
  endTimeLocal: number;
  avgWakingRespirationValue: number;
  highestRespirationValue: number;
  lowestRespirationValue: number;
  avgSleepRespirationValue?: number;
  epochRespiration?: Array<{
    startTimeGMT: number;
    respirationValue: number;
  }>;
}

export interface DailySpO2 {
  calendarDate: string;
  startTimestampGMT?: string;
  endTimestampGMT?: string;
  startTimestampLocal?: string;
  endTimestampLocal?: string;
  averageSpO2?: number;
  lowestSpO2?: number;
  latestSpO2?: number;
  latestSpO2ReadingTimeGMT?: string;
  latestSpO2ReadingTimeLocal?: string;
  spO2HourlyAverages?: Array<{
    epochTimestamp: number;
    spo2Value: number;
  }>;
}

// ============================================================
// Intensity minutes
// ============================================================

export interface DailyIntensityMinutes {
  calendarDate: string;
  weeklyGoal: number;
  moderateIntensityMinutes: number;
  vigorousIntensityMinutes: number;
}
