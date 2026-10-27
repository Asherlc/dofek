export interface InertialMeasurementUnitSample {
  timestamp: string;
  x: number;
  y: number;
  z: number;
  gyroscopeX?: number;
  gyroscopeY?: number;
  gyroscopeZ?: number;
}
