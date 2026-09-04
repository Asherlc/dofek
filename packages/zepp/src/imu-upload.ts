import {
  createHealthEnvelope,
  type HealthEnvelopeV1,
  type ZeppConnectionType,
} from "./health-contract.ts";
import type { ImuSample } from "./types.ts";

export interface ImuChunkPayload {
  segmentId: string;
  sessionStartMs: number;
  hasGyroscope: boolean;
  samples: ImuSample[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSample(value: unknown): ImuSample {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.tMs) ||
    Number(value.tMs) < 0 ||
    !Number.isFinite(value.ax) ||
    !Number.isFinite(value.ay) ||
    !Number.isFinite(value.az) ||
    !Number.isFinite(value.gx) ||
    !Number.isFinite(value.gy) ||
    !Number.isFinite(value.gz)
  ) {
    throw new Error("IMU envelope is invalid.");
  }
  return {
    tMs: Number(value.tMs),
    ax: Number(value.ax),
    ay: Number(value.ay),
    az: Number(value.az),
    gx: Number(value.gx),
    gy: Number(value.gy),
    gz: Number(value.gz),
  };
}

export function createImuChunkEnvelope(input: {
  connectionType: ZeppConnectionType;
  installId: string;
  segmentId: string;
  sessionStartMs: number;
  hasGyroscope?: boolean;
  samples: ImuSample[];
}): HealthEnvelopeV1<ImuChunkPayload> {
  const first = input.samples[0];
  const last = input.samples.at(-1);
  if (!first || !last) {
    throw new Error("Cannot create an empty IMU chunk.");
  }
  const eventId = `${input.segmentId}:${first.tMs}:${last.tMs}`;
  return createHealthEnvelope({
    batchId: eventId,
    source: { connectionType: input.connectionType, installId: input.installId },
    events: [
      {
        eventId,
        createdAt: new Date(input.sessionStartMs + last.tMs).toISOString(),
        payload: {
          segmentId: input.segmentId,
          sessionStartMs: input.sessionStartMs,
          hasGyroscope: input.hasGyroscope ?? true,
          samples: input.samples,
        },
      },
    ],
  });
}

export function parseImuEnvelope(value: unknown): HealthEnvelopeV1<ImuChunkPayload> {
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
  ) {
    throw new Error("IMU envelope is invalid.");
  }

  return {
    version: 1,
    batchId: value.batchId,
    source: {
      connectionType: value.source.connectionType,
      installId: value.source.installId,
    },
    events: value.events.map((event) => {
      if (
        !isRecord(event) ||
        typeof event.eventId !== "string" ||
        !event.eventId.trim() ||
        typeof event.createdAt !== "string" ||
        !event.createdAt.trim() ||
        !isRecord(event.payload) ||
        typeof event.payload.segmentId !== "string" ||
        !event.payload.segmentId.trim() ||
        !Number.isInteger(event.payload.sessionStartMs) ||
        typeof event.payload.hasGyroscope !== "boolean" ||
        !Array.isArray(event.payload.samples) ||
        event.payload.samples.length === 0
      ) {
        throw new Error("IMU envelope is invalid.");
      }
      return {
        eventId: event.eventId,
        createdAt: event.createdAt,
        payload: {
          segmentId: event.payload.segmentId,
          sessionStartMs: Number(event.payload.sessionStartMs),
          hasGyroscope: event.payload.hasGyroscope,
          samples: event.payload.samples.map(parseSample),
        },
      };
    }),
  };
}
