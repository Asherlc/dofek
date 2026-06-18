export type ActivityExportFormat = "gpx" | "tcx" | "csv" | "fit";

export interface ActivityExportPoint {
  recordedAt: string;
  heartRate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}

export interface ActivityExportInput {
  id: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  name: string | null;
  notes: string | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  avgCadence: number | null;
  totalDistance: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  points: ActivityExportPoint[];
}

export interface ActivityExportResult {
  body: Buffer;
  contentType: string;
  filename: string;
}
