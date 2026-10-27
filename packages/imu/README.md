# @dofek/imu

Canonical `InertialMeasurementUnitSample` interface shared across all IMU data sources.

## Usage

```ts
import type { InertialMeasurementUnitSample } from "@dofek/imu";
```

## Type

```ts
interface InertialMeasurementUnitSample {
  timestamp: string;       // ISO 8601
  x: number;               // acceleration in g
  y: number;
  z: number;
  gyroscopeX?: number;     // rotation rate in rad/s
  gyroscopeY?: number;
  gyroscopeZ?: number;
}
```

## Sources

| Source | Module | Notes |
|--------|--------|-------|
| iPhone CoreMotion | `packages/mobile/modules/core-motion` | CMSensorRecorder, 50 Hz |
| Apple Watch | `packages/mobile/modules/watch-motion` | WCSession file transfer |
| WHOOP BLE | `packages/mobile/modules/whoop-ble` | Native bridge maps `accelerometerX/Y/Z` to `x/y/z` |
| ZeppOS zepp | `zepp/` | Binary format decoded by `src/providers/zos-app/decode.ts` |
| Server | `packages/server/src/repositories/` | tRPC upload endpoint |
