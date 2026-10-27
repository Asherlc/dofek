import {
  createHealthEnvelope,
  type HealthEnvelopeV1,
  type ZeppConnectionType,
} from "./health-contract.ts";
import type { ImuSample } from "./types.ts";

interface ImuChunkBase {
  segmentId: string;
  sessionStartMs: number;
  hasGyroscope: boolean;
  samples: ImuSample[];
}

export type ImuChunkPayload = ImuChunkBase &
  (
    | { formatVersion: 1 }
    | { formatVersion: 2; sampleOffset: number; accelFreqMode: number; gyroFreqMode: number }
  );

export interface ImuConnectionBinding {
  serverUrl: string;
  accountId: string;
}

export type ImuEnvelope = HealthEnvelopeV1<ImuChunkPayload> & {
  destination?: ImuConnectionBinding;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsignedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function parseImuConnectionBinding(value: unknown): ImuConnectionBinding {
  if (
    !isRecord(value) ||
    typeof value.serverUrl !== "string" ||
    !value.serverUrl.trim() ||
    typeof value.accountId !== "string" ||
    !value.accountId.trim()
  ) {
    throw new Error("IMU connection binding is invalid.");
  }
  return {
    serverUrl: value.serverUrl.replace(/\/+$/, ""),
    accountId: value.accountId.trim(),
  };
}

function parseSample(value: unknown): ImuSample {
  if (
    !isRecord(value) ||
    !isUnsignedInteger(value.tMs, 0xffffffff) ||
    (value.sensor !== "accelerometer" && value.sensor !== "gyroscope") ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.z !== "number" ||
    !Number.isFinite(value.z)
  )
    throw new Error("IMU envelope is invalid.");
  return { tMs: value.tMs, sensor: value.sensor, x: value.x, y: value.y, z: value.z };
}

function parsePayload(value: unknown): ImuChunkPayload {
  if (
    !isRecord(value) ||
    typeof value.segmentId !== "string" ||
    !value.segmentId.trim() ||
    !isUnsignedInteger(value.sessionStartMs) ||
    typeof value.hasGyroscope !== "boolean" ||
    !Array.isArray(value.samples) ||
    value.samples.length === 0
  )
    throw new Error("IMU envelope is invalid.");
  let samples: ImuSample[];
  if (value.formatVersion === undefined) {
    if (value.samples.length > 100) throw new Error("IMU envelope is invalid.");
    samples = value.samples.flatMap((sample: unknown) => {
      if (!isRecord(sample)) throw new Error("IMU envelope is invalid.");
      const accel = parseSample({
        tMs: sample.tMs,
        sensor: "accelerometer",
        x: sample.ax,
        y: sample.ay,
        z: sample.az,
      });
      if (!value.hasGyroscope) return [accel];
      return [
        accel,
        parseSample({
          tMs: sample.tMs,
          sensor: "gyroscope",
          x: sample.gx,
          y: sample.gy,
          z: sample.gz,
        }),
      ];
    });
  } else {
    if (value.formatVersion !== 1 && value.formatVersion !== 2)
      throw new Error("IMU envelope is invalid.");
    samples = value.samples.map(parseSample);
  }
  if (
    samples.length > (value.formatVersion === 2 ? 128 : 200) ||
    (!value.hasGyroscope && samples.some((sample) => sample.sensor === "gyroscope"))
  ) {
    throw new Error("IMU envelope is invalid.");
  }
  const common = {
    segmentId: value.segmentId,
    sessionStartMs: value.sessionStartMs,
    hasGyroscope: value.hasGyroscope,
    samples,
  };
  if (value.formatVersion === 2) {
    if (
      !isUnsignedInteger(value.sampleOffset) ||
      !isUnsignedInteger(value.accelFreqMode, 255) ||
      !isUnsignedInteger(value.gyroFreqMode, 255)
    )
      throw new Error("IMU envelope is invalid.");
    return {
      ...common,
      formatVersion: 2,
      sampleOffset: value.sampleOffset,
      accelFreqMode: value.accelFreqMode,
      gyroFreqMode: value.gyroFreqMode,
    };
  }
  return { ...common, formatVersion: 1 };
}

export function createImuChunkEnvelope(input: {
  connectionType: ZeppConnectionType;
  installId: string;
  segmentId: string;
  sessionStartMs: number;
  hasGyroscope: boolean;
  sampleOffset: number;
  accelFreqMode: number;
  gyroFreqMode: number;
  samples: ImuSample[];
  destination?: ImuConnectionBinding;
}): ImuEnvelope {
  if (!input.installId.trim()) throw new Error("IMU envelope is invalid.");
  const payload = parsePayload({ ...input, formatVersion: 2 });
  const last = payload.samples.at(-1);
  if (!last) throw new Error("Cannot create an empty IMU chunk.");
  const createdAt = new Date(input.sessionStartMs + last.tMs);
  if (Number.isNaN(createdAt.getTime())) throw new Error("IMU envelope is invalid.");
  const eventId = `${input.segmentId}:${input.sampleOffset}`;
  const envelope: ImuEnvelope = createHealthEnvelope({
    batchId: eventId,
    source: { connectionType: input.connectionType, installId: input.installId },
    events: [{ eventId, createdAt: createdAt.toISOString(), payload }],
  });
  if (input.destination) {
    envelope.destination = parseImuConnectionBinding(input.destination);
  }
  return envelope;
}

export function parseImuEnvelope(value: unknown): ImuEnvelope {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.batchId !== "string" ||
    !value.batchId.trim() ||
    !isRecord(value.source) ||
    (value.source.connectionType !== "zepp" && value.source.connectionType !== "zepp-workout") ||
    typeof value.source.installId !== "string" ||
    !value.source.installId.trim() ||
    !Array.isArray(value.events) ||
    value.events.length === 0
  )
    throw new Error("IMU envelope is invalid.");
  return {
    version: 1,
    batchId: value.batchId,
    source: { connectionType: value.source.connectionType, installId: value.source.installId },
    ...(value.destination === undefined
      ? {}
      : { destination: parseImuConnectionBinding(value.destination) }),
    events: value.events.map((event: unknown) => {
      if (
        !isRecord(event) ||
        typeof event.eventId !== "string" ||
        !event.eventId.trim() ||
        typeof event.createdAt !== "string" ||
        !event.createdAt.trim()
      )
        throw new Error("IMU envelope is invalid.");
      return {
        eventId: event.eventId,
        createdAt: event.createdAt,
        payload: parsePayload(event.payload),
      };
    }),
  };
}
