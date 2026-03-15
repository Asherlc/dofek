// ============================================================
// Zwift API response types (reverse-engineered)
// ============================================================

export interface ZwiftTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface ZwiftProfile {
  id: number;
  firstName: string;
  lastName: string;
  ftp: number;
  weight: number; // grams
  height: number; // cm
}

export interface ZwiftActivitySummary {
  id: number;
  id_str: string;
  profileId: number;
  name: string;
  startDate: string; // ISO
  endDate: string; // ISO
  distanceInMeters: number;
  avgHeartRate: number;
  maxHeartRate: number;
  avgWatts: number;
  maxWatts: number;
  avgCadenceInRotationsPerMinute: number;
  avgSpeedInMetersPerSecond: number;
  maxSpeedInMetersPerSecond: number;
  totalElevationInMeters: number;
  calories: number;
  sport: string; // "CYCLING", "RUNNING"
  rideOnGiven: number;
  activityRideOnCount: number;
}

export interface ZwiftActivityDetail {
  id: number;
  id_str: string;
  profileId: number;
  name: string;
  startDate: string;
  endDate: string;
  distanceInMeters: number;
  avgHeartRate: number;
  maxHeartRate: number;
  avgWatts: number;
  maxWatts: number;
  avgCadenceInRotationsPerMinute: number;
  avgSpeedInMetersPerSecond: number;
  maxSpeedInMetersPerSecond: number;
  totalElevationInMeters: number;
  calories: number;
  sport: string;
  fitnessData?: {
    fullDataUrl?: string;
  };
}

export interface ZwiftFitnessData {
  powerInWatts?: number[];
  heartRate?: number[];
  cadencePerMin?: number[];
  distanceInCm?: number[];
  speedInCmPerSec?: number[];
  altitudeInCm?: number[];
  latlng?: Array<[number, number]>;
  timeInSec?: number[];
}

export interface ZwiftPowerCurve {
  zFtp?: number;
  zMap?: number;
  vo2Max?: number;
  efforts?: Array<{
    duration: number; // seconds
    watts: number;
    timestamp: string;
  }>;
}
