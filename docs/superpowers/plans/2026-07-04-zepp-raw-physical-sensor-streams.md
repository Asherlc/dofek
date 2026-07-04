# Zepp Raw Physical Sensor Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Zepp OS session exports to include raw passive physical sensor streams alongside IMU, then publish those samples through the existing metric-stream pipeline.

**Architecture:** Keep v1 IMU-only files readable. Add a v2 typed-chunk binary format: chunk type `1` for IMU records, `2` for scalar sensor samples, and `3` for passive location points. Watch-side collection writes raw samples only; server import decodes v2 health/environment records and publishes metric-stream rows through `MetricStreamEventPublisher`. Location is passive-only: never call `Geolocation.start()` from Dofek logging unless implementation evidence proves it attaches only to an already-active native fix.

**Tech Stack:** TypeScript, Vitest, Zepp OS `@zos/sensor`, existing `MetricStreamEventPublisher`, existing metric-stream channel constants.

---

## File Structure

- Modify `packages/zepp/src/types.ts`: add sensor sample/channel types.
- Modify `packages/zepp/src/imu-format.ts`: add v2 typed chunk encoder while preserving v1 header helpers.
- Modify `src/providers/zos-app/decode.ts`: decode both v1 and v2 files.
- Modify `packages/zepp/src/imu-format.test.ts`: cover v2 mixed chunks.
- Modify `src/providers/zos-app/decode.test.ts`: cover v2 mixed chunks and v1 compatibility.
- Create `packages/zepp/src/physical-sensor-collector.ts`: testable collector for HR, SpO2, stress, temperature, barometer, compass, and passive location.
- Create `packages/zepp/src/physical-sensor-collector.test.ts`: raw/computed filtering, SpO2 resilience, passive-location behavior.
- Modify `packages/zepp/src/env.d.ts`: add Zepp sensor typings for HR callbacks, SpO2 status, barometer, compass, and geolocation.
- Modify `packages/zepp/app.json`: add `device:os.compass`, `device:os.barometer`, and `device:os.geolocation` permissions.
- Modify `packages/zepp/page/index.ts`: wire physical collector into session lifecycle and file flushing.
- Modify `packages/zepp/README.md`: document v2 chunks and passive-location rule.
- Modify `src/db/sensor-channels.ts`: add `BAROMETRIC_PRESSURE` and `COMPASS_HEADING` constants.
- Modify `src/providers/zos-app/provider.ts`: publish decoded sensor samples to metric stream.
- Modify `src/providers/zos-app/provider.test.ts`: verify metric-stream publishing and no Postgres metric_stream writes.

## V2 Binary Format

Header stays 32 bytes, with byte 4 set to `2` for v2. V2 chunks use a typed chunk header:

```text
chunk_type uint8
flags      uint8
count      uint16 little-endian
records    count * record_size
```

Chunk type `1`: IMU records. Record layout matches v1 accel or accel+gyro records, selected by header `FLAG_HAS_GYRO`.

Chunk type `2`: scalar physical samples.

```text
t_ms       uint32 little-endian
channel_id uint8
status     uint8
reserved   uint16
value      float64 little-endian
```

Chunk type `3`: passive location samples.

```text
t_ms       uint32 little-endian
latitude   float64 little-endian
longitude  float64 little-endian
altitude_m float32 little-endian, NaN when absent
```

Scalar channel ids:

```typescript
export const PHYSICAL_SENSOR_CHANNEL_IDS = {
  heartRate: 1,
  spo2: 2,
  stress: 3,
  bodyTemperature: 4,
  barometricPressure: 5,
  altitude: 6,
  compassHeading: 7,
} as const;
```

## Task 1: Add V2 Encoder And Decoder

**Files:**
- Modify: `packages/zepp/src/types.ts`
- Modify: `packages/zepp/src/imu-format.ts`
- Modify: `packages/zepp/src/imu-format.test.ts`
- Modify: `src/providers/zos-app/decode.ts`
- Modify: `src/providers/zos-app/decode.test.ts`

- [ ] **Step 1: Write failing Zepp encoder tests**

Add this test to `packages/zepp/src/imu-format.test.ts`:

```typescript
it("encodes v2 chunks with imu, scalar physical samples, and passive locations", () => {
  const header = createHeader({
    hasGyro: true,
    sessionStartMs: 1_719_300_000_000,
    sampleCount: 2,
    accelFreqMode: 2,
    gyroFreqMode: 2,
    observedHzX100: 5000,
    formatVersion: 2,
  });
  const imuChunk = encodeImuChunk(
    [
      { tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 },
      { tMs: 20, ax: 7, ay: 8, az: 9, gx: 10, gy: 11, gz: 12 },
    ],
    true,
  );
  const scalarChunk = encodePhysicalScalarChunk([
    { tMs: 10, channel: "heartRate", value: 72 },
    { tMs: 15, channel: "spo2", value: 0.98 },
  ]);
  const locationChunk = encodeLocationChunk([
    { tMs: 30, latitude: 37.7749, longitude: -122.4194, altitude: 18 },
  ]);

  expect(new DataView(header).getUint8(4)).toBe(2);
  expect(new DataView(imuChunk).getUint8(0)).toBe(1);
  expect(new DataView(imuChunk).getUint16(2, true)).toBe(2);
  expect(new DataView(scalarChunk).getUint8(0)).toBe(2);
  expect(new DataView(scalarChunk).getUint16(2, true)).toBe(2);
  expect(new DataView(locationChunk).getUint8(0)).toBe(3);
  expect(new DataView(locationChunk).getUint16(2, true)).toBe(1);
});
```

- [ ] **Step 2: Run encoder test to verify RED**

Run:

```bash
rtk pnpm vitest run packages/zepp/src/imu-format.test.ts --testNamePattern "encodes v2 chunks"
```

Expected: FAIL because `formatVersion`, `encodeImuChunk`, `encodePhysicalScalarChunk`, and `encodeLocationChunk` do not exist.

- [ ] **Step 3: Implement Zepp v2 types**

Add to `packages/zepp/src/types.ts`:

```typescript
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
```

Also add `formatVersion?: number` to `HeaderMeta`.

- [ ] **Step 4: Implement v2 encoder helpers**

In `packages/zepp/src/imu-format.ts`, add exports:

```typescript
export const FORMAT_VERSION_V2 = 2;
export const CHUNK_TYPE_IMU = 1;
export const CHUNK_TYPE_SCALAR = 2;
export const CHUNK_TYPE_LOCATION = 3;
export const SCALAR_RECORD_SIZE = 16;
export const LOCATION_RECORD_SIZE = 24;

export const PHYSICAL_SENSOR_CHANNEL_IDS = {
  heartRate: 1,
  spo2: 2,
  stress: 3,
  bodyTemperature: 4,
  barometricPressure: 5,
  altitude: 6,
  compassHeading: 7,
} as const;
```

Update `createHeader()` so it reads `formatVersion = FORMAT_VERSION` and writes that value at byte `4`.

Add:

```typescript
function createTypedChunkHeader(chunkType: number, count: number, recordBytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + count * recordBytes);
  const view = new DataView(buffer);
  view.setUint8(0, chunkType);
  view.setUint8(1, 0);
  view.setUint16(2, count, true);
  return buffer;
}

export function encodeImuChunk(samples: ImuSample[], hasGyro: boolean): ArrayBuffer {
  const recordSize = hasGyro ? 28 : 16;
  const buffer = createTypedChunkHeader(CHUNK_TYPE_IMU, samples.length, recordSize);
  const view = new DataView(buffer);
  let offset = 4;
  for (const sample of samples) {
    view.setUint32(offset, sample.tMs >>> 0, true);
    offset += 4;
    view.setFloat32(offset, sample.ax, true);
    offset += 4;
    view.setFloat32(offset, sample.ay, true);
    offset += 4;
    view.setFloat32(offset, sample.az, true);
    offset += 4;

    if (hasGyro) {
      view.setFloat32(offset, sample.gx || 0, true);
      offset += 4;
      view.setFloat32(offset, sample.gy || 0, true);
      offset += 4;
      view.setFloat32(offset, sample.gz || 0, true);
      offset += 4;
    }
  }
  return buffer;
}

export function encodePhysicalScalarChunk(samples: PhysicalScalarSample[]): ArrayBuffer {
  const buffer = createTypedChunkHeader(CHUNK_TYPE_SCALAR, samples.length, SCALAR_RECORD_SIZE);
  const view = new DataView(buffer);
  let offset = 4;
  for (const sample of samples) {
    view.setUint32(offset, sample.tMs >>> 0, true);
    offset += 4;
    view.setUint8(offset, PHYSICAL_SENSOR_CHANNEL_IDS[sample.channel]);
    offset += 1;
    view.setUint8(offset, sample.status ?? 0);
    offset += 1;
    view.setUint16(offset, 0, true);
    offset += 2;
    view.setFloat64(offset, sample.value, true);
    offset += 8;
  }
  return buffer;
}

export function encodeLocationChunk(samples: LocationSample[]): ArrayBuffer {
  const buffer = createTypedChunkHeader(CHUNK_TYPE_LOCATION, samples.length, LOCATION_RECORD_SIZE);
  const view = new DataView(buffer);
  let offset = 4;
  for (const sample of samples) {
    view.setUint32(offset, sample.tMs >>> 0, true);
    offset += 4;
    view.setFloat64(offset, sample.latitude, true);
    offset += 8;
    view.setFloat64(offset, sample.longitude, true);
    offset += 8;
    view.setFloat32(offset, sample.altitude ?? Number.NaN, true);
    offset += 4;
  }
  return buffer;
}
```

- [ ] **Step 5: Run Zepp encoder tests**

Run:

```bash
rtk pnpm vitest run packages/zepp/src/imu-format.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing server decoder tests**

Add to `src/providers/zos-app/decode.test.ts`:

```typescript
it("decodes a v2 session with scalar physical samples and passive location", () => {
  const header = createHeader({
    hasGyro: false,
    sessionStartMs: 1_719_300_000_000,
    sampleCount: 1,
    observedHzX100: 5000,
  });
  new DataView(header).setUint8(4, 2);
  const imuChunk = concat(new Uint8Array([1]).buffer, encodeChunk([{ tMs: 0, ax: 1, ay: 2, az: 3 }], false).slice(1));
  const scalarChunk = new ArrayBuffer(4 + 2 * 16);
  const scalarView = new DataView(scalarChunk);
  scalarView.setUint8(0, 2);
  scalarView.setUint16(2, 2, true);
  scalarView.setUint32(4, 10, true);
  scalarView.setUint8(8, 1);
  scalarView.setFloat64(12, 72, true);
  scalarView.setUint32(20, 15, true);
  scalarView.setUint8(24, 2);
  scalarView.setFloat64(28, 0.98, true);
  const locationChunk = new ArrayBuffer(28);
  const locationView = new DataView(locationChunk);
  locationView.setUint8(0, 3);
  locationView.setUint16(2, 1, true);
  locationView.setUint32(4, 30, true);
  locationView.setFloat64(8, 37.7749, true);
  locationView.setFloat64(16, -122.4194, true);
  locationView.setFloat32(24, 18, true);

  const result = decodeBin(concat(header, imuChunk, scalarChunk, locationChunk));

  expect(result.samples).toHaveLength(1);
  expect(result.physicalSamples).toEqual([
    { tMs: 10, channel: "heartRate", value: 72, status: 0 },
    { tMs: 15, channel: "spo2", value: 0.98, status: 0 },
  ]);
  expect(result.locationSamples).toEqual([
    { tMs: 30, latitude: 37.7749, longitude: -122.4194, altitude: expect.closeTo(18) },
  ]);
});
```

If TypeScript rejects `expect.closeTo()` inside `toEqual`, assert the location fields separately with `toBeCloseTo`.

- [ ] **Step 7: Run decoder test to verify RED**

Run:

```bash
rtk pnpm vitest run src/providers/zos-app/decode.test.ts --testNamePattern "decodes a v2 session"
```

Expected: FAIL because v2 typed chunks and physical sample fields are not decoded.

- [ ] **Step 8: Implement server v2 decoder**

Modify `src/providers/zos-app/decode.ts`:

```typescript
export interface PhysicalScalarDecodedSample {
  tMs: number;
  channel:
    | "heartRate"
    | "spo2"
    | "stress"
    | "bodyTemperature"
    | "barometricPressure"
    | "altitude"
    | "compassHeading";
  value: number;
  status: number;
}

export interface LocationDecodedSample {
  tMs: number;
  latitude: number;
  longitude: number;
  altitude?: number;
}
```

Add `physicalSamples: PhysicalScalarDecodedSample[]` and `locationSamples: LocationDecodedSample[]` to `DecodedSession`. Keep v1 returning empty arrays for both.

Decode v1 exactly as today when `version === 1`. Decode v2 by reading typed chunks:

```typescript
const CHANNEL_BY_ID: Record<number, PhysicalScalarDecodedSample["channel"]> = {
  1: "heartRate",
  2: "spo2",
  3: "stress",
  4: "bodyTemperature",
  5: "barometricPressure",
  6: "altitude",
  7: "compassHeading",
};
```

For unknown chunk types, throw `Unsupported v2 chunk type: ${chunkType}`. For unknown scalar channel ids, throw `Unsupported physical sample channel id: ${channelId}`.

- [ ] **Step 9: Run decoder tests**

Run:

```bash
rtk pnpm vitest run src/providers/zos-app/decode.test.ts
```

Expected: PASS, including v1 compatibility.

- [ ] **Step 10: Commit Task 1**

Run:

```bash
rtk git add packages/zepp/src/types.ts packages/zepp/src/imu-format.ts packages/zepp/src/imu-format.test.ts src/providers/zos-app/decode.ts src/providers/zos-app/decode.test.ts
rtk git commit -m "feat: add zepp v2 physical stream format"
```

## Task 2: Add Testable Physical Sensor Collector

**Files:**
- Create: `packages/zepp/src/physical-sensor-collector.ts`
- Create: `packages/zepp/src/physical-sensor-collector.test.ts`
- Modify: `packages/zepp/src/env.d.ts`

- [ ] **Step 1: Write failing collector tests**

Create `packages/zepp/src/physical-sensor-collector.test.ts` with tests for:

```typescript
it("records raw heart rate and barometer samples", () => {
  const samples: unknown[] = [];
  const collector = createPhysicalSensorCollector({
    onScalarSample: (sample) => samples.push(sample),
    onLocationSample: () => {},
  }, makeDeps());

  collector.start(1_000);
  deps.heartRate.emitCurrent(72);
  deps.barometer.emitChange({ airPressure: 1012.3, altitude: 42 });

  expect(samples).toContainEqual({ tMs: 0, channel: "heartRate", value: 72 });
  expect(samples).toContainEqual({ tMs: 0, channel: "barometricPressure", value: 1012.3 });
  expect(samples).toContainEqual({ tMs: 0, channel: "altitude", value: 42 });
});

it("ignores computed summary sensors", () => {
  const samples: unknown[] = [];
  const collector = createPhysicalSensorCollector({
    onScalarSample: (sample) => samples.push(sample),
    onLocationSample: () => {},
  }, makeDeps());

  collector.start(1_000);
  deps.step.emitChange(1234);
  deps.calorie.emitChange(200);

  expect(samples).toEqual([]);
});

it("does not throw or stop when spo2 measurement fails", () => {
  const samples: unknown[] = [];
  const collector = createPhysicalSensorCollector({
    onScalarSample: (sample) => samples.push(sample),
    onLocationSample: () => {},
  }, makeDeps({ bloodOxygenStatus: 3 }));

  collector.start(1_000);
  expect(() => deps.bloodOxygen.emitChange()).not.toThrow();
  deps.heartRate.emitCurrent(73);

  expect(samples).toEqual([{ tMs: 0, channel: "heartRate", value: 73 }]);
});

it("does not start geolocation and records only already-valid passive fixes", () => {
  const locations: unknown[] = [];
  const collector = createPhysicalSensorCollector({
    onScalarSample: () => {},
    onLocationSample: (sample) => locations.push(sample),
  }, makeDeps({ geolocationStatus: "A", latitude: 37.1, longitude: -122.1 }));

  collector.start(1_000);
  deps.geolocation.emitChange();

  expect(deps.geolocation.startCalls).toBe(0);
  expect(locations).toEqual([{ tMs: 0, latitude: 37.1, longitude: -122.1 }]);
});
```

Build `makeDeps()` with in-memory fake sensor classes. Do not import Zepp OS modules in the test.

- [ ] **Step 2: Run collector tests to verify RED**

Run:

```bash
rtk pnpm vitest run packages/zepp/src/physical-sensor-collector.test.ts
```

Expected: FAIL because the file does not exist.

- [ ] **Step 3: Implement collector boundary**

Create `packages/zepp/src/physical-sensor-collector.ts`:

```typescript
import type { LocationSample, PhysicalScalarSample } from "./types.ts";

export interface PhysicalSensorCollectorCallbacks {
  onScalarSample(sample: PhysicalScalarSample): void;
  onLocationSample(sample: LocationSample): void;
  onStatus?(status: { enabledChannels: string[]; disabledChannels: string[] }): void;
}

export interface PhysicalSensorDeps {
  now(): number;
  HeartRate?: new () => {
    getCurrent(): number;
    onCurrentChange(callback: () => void): void;
    offCurrentChange(callback: () => void): void;
  };
  BloodOxygen?: new () => {
    start(): void;
    stop(): void;
    getCurrent(): { value?: number; status?: number };
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
  Barometer?: new () => {
    getAirPressure(): number;
    getAltitude(): number;
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
  Compass?: new () => {
    start(): void;
    stop(): void;
    getStatus(): boolean;
    getDirectionAngle(): number | "INVALID";
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
  Geolocation?: new () => {
    getStatus(): string;
    getLatitude(option?: { format?: "DD" }): number;
    getLongitude(option?: { format?: "DD" }): number;
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
}
```

Implement `createPhysicalSensorCollector(callbacks, deps)` with `start(sessionStartMs)`, `stop()`, and no computed summary dependencies. Use `deps.now() - sessionStartMs` for `tMs`.

Rules:

- HR callback emits `heartRate` only when value is finite and greater than `0`.
- SpO2 callback emits `spo2` as `value / 100` only when value is finite and between `1` and `100`; all statuses/failures are ignored.
- Barometer callback emits both `barometricPressure` and `altitude` when finite.
- Compass callback starts compass, emits `compassHeading` only when calibrated and numeric.
- Geolocation callback never calls `start()`. It only subscribes with `onChange()` and reads coordinates when `getStatus() === "A"`.

- [ ] **Step 4: Update Zepp env typings**

Extend `packages/zepp/src/env.d.ts` sensor declarations for the APIs used in the collector. Add `Barometer`, `Compass`, and `Geolocation` classes. Update `HeartRate` with `onCurrentChange` / `offCurrentChange`; update `BloodOxygen` with `start`, `stop`, `onChange`, and `offChange`.

- [ ] **Step 5: Run collector tests**

Run:

```bash
rtk pnpm vitest run packages/zepp/src/physical-sensor-collector.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
rtk git add packages/zepp/src/physical-sensor-collector.ts packages/zepp/src/physical-sensor-collector.test.ts packages/zepp/src/env.d.ts
rtk git commit -m "feat: collect zepp physical sensor samples"
```

## Task 3: Wire Collector Into Zepp Session Files

**Files:**
- Modify: `packages/zepp/page/index.ts`
- Modify: `packages/zepp/app.json`
- Modify: `packages/zepp/src/session-file.ts`
- Modify: `packages/zepp/README.md`

- [ ] **Step 1: Write failing session-file test**

Add a test to `packages/zepp/src/session-file.test.ts` that spies on `writeSync` and verifies a flush can append scalar and location chunks after IMU chunks:

```typescript
it("appends physical sensor chunks", () => {
  appendPhysicalSamples(
    [{ tMs: 10, channel: "heartRate", value: 72 }],
    [{ tMs: 20, latitude: 37.1, longitude: -122.1 }],
    "data://imu/session.bin",
  );

  expect(writeSync).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run session-file test to verify RED**

Run:

```bash
rtk pnpm vitest run packages/zepp/src/session-file.test.ts --testNamePattern "appends physical sensor chunks"
```

Expected: FAIL because `appendPhysicalSamples` does not exist.

- [ ] **Step 3: Implement session append helper**

In `packages/zepp/src/session-file.ts`, import `encodePhysicalScalarChunk`, `encodeLocationChunk`, and `concatArrayBuffers`. Add:

```typescript
export function appendPhysicalSamples(
  scalarSamples: PhysicalScalarSample[],
  locationSamples: LocationSample[],
  path: string,
): void {
  const chunks: ArrayBuffer[] = [];
  if (scalarSamples.length > 0) chunks.push(encodePhysicalScalarChunk(scalarSamples));
  if (locationSamples.length > 0) chunks.push(encodeLocationChunk(locationSamples));
  if (chunks.length === 0) return;

  const fd = openSync({ path, flag: O_WRONLY | O_APPEND | O_CREAT });
  try {
    writeSync({ fd, data: concatArrayBuffers(chunks) });
  } finally {
    closeSync({ fd });
  }
}
```

- [ ] **Step 4: Wire page state**

In `packages/zepp/page/index.ts`:

- Import `Barometer`, `Compass`, and `Geolocation` from `@zos/sensor`.
- Import `createPhysicalSensorCollector`.
- Add `pendingScalarSamples`, `pendingLocationSamples`, and `physicalCollector` to page state.
- When starting logging, create the collector with callbacks that push into those pending buffers.
- Pass `Date.now()` session start into both the IMU session header and `physicalCollector.start(sessionStartMs)`.
- On `flushBuffer()`, after `appendSamples()`, call `appendPhysicalSamples()` with the pending physical buffers and clear them.
- On `stopLogging()`, stop the physical collector before final flush.

Do not call `Geolocation.start()` anywhere in `page/index.ts`.

- [ ] **Step 5: Add permissions**

In `packages/zepp/app.json`, add:

```json
"device:os.barometer",
"device:os.compass",
"device:os.geolocation"
```

Keep existing health permissions. Do not add unrelated screen, battery, weather, or wear permissions.

- [ ] **Step 6: Update README**

Update `packages/zepp/README.md` binary format section with v2 typed chunks and a note:

```markdown
Location samples are passive-only. The Dofek page subscribes to already-available location changes but does not start GNSS for Dofek logging; if the watch is not already producing a valid fix, no location sample is written.
```

- [ ] **Step 7: Run Zepp package tests**

Run:

```bash
rtk pnpm vitest run packages/zepp/src
rtk pnpm --filter @dofek/zepp typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
rtk git add packages/zepp/page/index.ts packages/zepp/app.json packages/zepp/src/session-file.ts packages/zepp/src/session-file.test.ts packages/zepp/README.md
rtk git commit -m "feat: include physical samples in zepp sessions"
```

## Task 4: Publish Decoded Physical Samples To Metric Stream

**Files:**
- Modify: `src/db/sensor-channels.ts`
- Modify: `src/providers/zos-app/provider.ts`
- Modify: `src/providers/zos-app/provider.test.ts`

- [ ] **Step 1: Write failing provider test**

Update `src/providers/zos-app/provider.test.ts` so `makeDecodedSession()` can return:

```typescript
physicalSamples: [
  { tMs: 10, channel: "heartRate", value: 72, status: 0 },
  { tMs: 15, channel: "spo2", value: 0.98, status: 0 },
  { tMs: 20, channel: "barometricPressure", value: 1012.3, status: 0 },
  { tMs: 25, channel: "compassHeading", value: 180, status: 0 },
],
locationSamples: [{ tMs: 30, latitude: 37.7749, longitude: -122.4194, altitude: 18 }],
```

Mock a `metricStreamPublisher` with `publishRows`. Add:

```typescript
it("publishes decoded physical samples to metric stream", async () => {
  const publishedRows: unknown[] = [];
  const metricStreamPublisher = {
    publishRows: vi.fn(async (rows: readonly unknown[]) => {
      publishedRows.push(...rows);
      return [];
    }),
  };
  mockDecodeBin.mockReturnValue(makeDecodedSession({
    physicalSamples: [
      { tMs: 10, channel: "heartRate", value: 72, status: 0 },
      { tMs: 15, channel: "spo2", value: 0.98, status: 0 },
    ],
    locationSamples: [{ tMs: 30, latitude: 37.7749, longitude: -122.4194, altitude: 18 }],
  }));

  await importZosAppBin(mockDb, Buffer.from([0x00]), "00000000-0000-4000-8000-000000000001", metricStreamPublisher);

  expect(publishedRows).toEqual([
    expect.objectContaining({ channel: "heart_rate", scalar: 72 }),
    expect.objectContaining({ channel: "spo2", scalar: 0.98 }),
    expect.objectContaining({ channel: "location", point: "SRID=4326;POINT(-122.4194 37.7749)" }),
    expect.objectContaining({ channel: "altitude", scalar: 18 }),
  ]);
});
```

- [ ] **Step 2: Run provider test to verify RED**

Run:

```bash
rtk pnpm vitest run src/providers/zos-app/provider.test.ts --testNamePattern "publishes decoded physical samples"
```

Expected: FAIL because `importZosAppBin()` does not accept a metric publisher or publish decoded physical samples.

- [ ] **Step 3: Add metric-stream channels**

In `src/db/sensor-channels.ts`, add:

```typescript
/** Barometric pressure in hPa */
export const BAROMETRIC_PRESSURE = "barometric_pressure";
/** Compass heading in degrees clockwise from north */
export const COMPASS_HEADING = "compass_heading";
```

Add mappings:

```typescript
barometricPressure: BAROMETRIC_PRESSURE,
compassHeading: COMPASS_HEADING,
```

- [ ] **Step 4: Publish rows from import**

Update `src/providers/zos-app/provider.ts`:

- Add optional fourth parameter `metricStreamPublisher?: MetricStreamEventPublisher` to `importZosAppBin`.
- Map decoded scalar sample channels to canonical metric-stream channels:

```typescript
const ZOS_SCALAR_CHANNEL_TO_METRIC_STREAM = {
  heartRate: HEART_RATE,
  spo2: SPO2,
  stress: STRESS,
  bodyTemperature: BODY_TEMPERATURE,
  barometricPressure: BAROMETRIC_PRESSURE,
  altitude: ALTITUDE,
  compassHeading: COMPASS_HEADING,
} satisfies Record<PhysicalScalarDecodedSample["channel"], string>;
```

- Build rows with `recordedAt = new Date(decoded.sessionStartMs + sample.tMs)`, `providerId = "zos-app"`, `sourceType = SOURCE_TYPE_FILE`, stable external IDs like `zos-app:${decoded.sessionStartMs}:${channel}:${sample.tMs}`.
- Publish scalar rows and location rows via `publisher.publishRows(rows)`.
- For location, create one `location` point row and one `altitude` scalar row when altitude is finite.
- Return `recordsSynced` as `1 + publishedRowCount` or keep session count `1` if existing sync result semantics should remain unchanged. Prefer `1 + publishedRowCount` so import result reflects stored samples.

- [ ] **Step 5: Run provider tests**

Run:

```bash
rtk pnpm vitest run src/providers/zos-app/provider.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
rtk git add src/db/sensor-channels.ts src/providers/zos-app/provider.ts src/providers/zos-app/provider.test.ts
rtk git commit -m "feat: publish zepp physical streams"
```

## Task 5: Final Verification

**Files:**
- All changed files

- [ ] **Step 1: Run targeted tests**

Run:

```bash
rtk pnpm vitest run packages/zepp/src/imu-format.test.ts packages/zepp/src/session-file.test.ts packages/zepp/src/physical-sensor-collector.test.ts src/providers/zos-app/decode.test.ts src/providers/zos-app/provider.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typechecks**

Run:

```bash
rtk pnpm --filter @dofek/zepp typecheck
rtk pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
rtk pnpm lint
```

Expected: PASS.

- [ ] **Step 4: Review diffs for forbidden scope**

Run:

```bash
rtk rg -n "Screen|Battery|Weather|Wear|Step|Calorie|Distance|Pai|FatBurning|Geolocation\\.start|geolocation\\.start" packages/zepp/src packages/zepp/page src/providers/zos-app
```

Expected:

- No `Screen`, `Battery`, `Weather`, or `Wear` imports in new collection code.
- No `Step`, `Calorie`, `Distance`, `Pai`, or `FatBurning` samples emitted into the raw physical stream.
- No `Geolocation.start()` or `geolocation.start()` in Dofek logging code.

- [ ] **Step 5: Commit verification-only fixes if needed**

If formatting, lint, or typecheck fixes were necessary, review the changed file list and commit exactly those fixes:

```bash
rtk git diff --name-only
rtk git add packages/zepp src
rtk git commit -m "fix: polish zepp physical stream implementation"
```

Do not create an empty commit if no fixes were needed.

## Self-Review

- Spec coverage: IMU compatibility, raw HR, SpO2 resilience, stress/body temperature conditionality, barometer, compass, passive-only location, metric-stream publishing, and computed-summary exclusion are covered by Tasks 1-5.
- Placeholder scan: No placeholder markers remain in task instructions. Stress/body-temperature and location uncertainty are handled with explicit omit-rather-than-guess rules.
- Type consistency: Watch-side channels use camelCase `PhysicalScalarChannel`; server maps them to canonical metric-stream channel strings.
