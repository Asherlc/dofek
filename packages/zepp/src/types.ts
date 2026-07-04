export interface ImuSample {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  gx?: number;
  gy?: number;
  gz?: number;
}

export type PhysicalScalarChannel =
  | "heartRate"
  | "spo2"
  | "stress"
  | "bodyTemperature"
  | "barometricPressure"
  | "altitude"
  | "compassHeading";

export interface PhysicalScalarSample {
  tMs: number;
  channel: PhysicalScalarChannel;
  value: number;
  status?: number;
}

export interface LocationSample {
  tMs: number;
  latitude: number;
  longitude: number;
  altitude?: number;
}

export interface HeaderMeta {
  formatVersion?: number;
  hasGyro?: boolean;
  sessionStartMs?: number;
  sampleCount?: number;
  accelFreqMode?: number;
  gyroFreqMode?: number;
  observedHzX100?: number;
}

export interface CollectorOptions {
  enableGyro?: boolean;
  requestedFreqModeIndex?: number;
  onSample: (sample: ImuSample) => void;
  onStatus?: (stats: { sampleCount: number; observedHzX100: number }) => void;
}

export interface CollectorStats {
  sampleCount: number;
  observedHzX100: number;
  sessionStartMs: number;
}

export interface ErrorCollector {
  available: false;
  reason: string;
  start(): void;
  stop(): void;
}

export interface ReadyCollector {
  available: true;
  hasGyroscope: boolean;
  accelMode: number;
  gyroMode: number | null;
  getStats(): CollectorStats;
  start(): void;
  stop(): void;
}

export type ImuCollector = ErrorCollector | ReadyCollector;

export interface FreqModeEntry {
  value: number;
  label: string;
  rank: number;
}

export interface SessionFileMeta {
  hasGyro: boolean;
  sessionStartMs: number;
  sampleCount: number;
  accelFreqMode: number;
  gyroFreqMode: number;
  observedHzX100: number;
}
