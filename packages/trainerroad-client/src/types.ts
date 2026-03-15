export interface TrainerRoadMemberInfo {
  MemberId: number;
  Username: string;
}

export interface TrainerRoadActivity {
  Id: number;
  WorkoutName: string;
  CompletedDate: string; // ISO
  Duration: number; // seconds
  Tss: number;
  DistanceInMeters: number;
  IsOutside: boolean;
  ActivityType: string; // "Ride", "Run", "Swim", "VirtualRide", etc.
  IfFactor: number;
  NormalizedPower: number;
  AveragePower: number;
  MaxPower: number;
  AverageHeartRate: number;
  MaxHeartRate: number;
  AverageCadence: number;
  MaxCadence: number;
  Calories: number;
  ElevationGainInMeters: number;
  AverageSpeed: number; // m/s
  MaxSpeed: number; // m/s
}

export interface TrainerRoadCareer {
  Ftp: number;
  Weight: number; // kg
}
