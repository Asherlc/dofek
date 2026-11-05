import { randomUUID } from "node:crypto";
import Pulsar from "pulsar-client";
import {
  metricStreamPosition,
  type PulsarMetricStreamPosition,
} from "../metric-stream/transport-position.ts";
import type { AnalyticsEffect } from "./effect-journal.ts";
import type { AnalyticsStream } from "./journal-position.ts";

const { MessageId } = Pulsar;

export function completedExecResult(
  writtenRows: string,
  stream = Readable.from([]),
): Awaited<ReturnType<ReturnType<typeof createClient>["exec"]>> {
  return {
    stream,
    query_id: "fixture-query",
    response_headers: {},
    http_status_code: 200,
    summary: {
      written_rows: writtenRows,
      written_bytes: "0",
      read_rows: "0",
      read_bytes: "0",
      total_rows_to_read: "0",
      result_rows: "0",
      result_bytes: "0",
      elapsed_ns: "0",
    },
  };
}

export function analyticsPosition(
  stream: AnalyticsStream,
  entry: bigint,
): PulsarMetricStreamPosition {
  const bytes = [8, 10, 16];
  let remaining = entry;
  while (remaining >= 128n) {
    bytes.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  if (stream.partition >= 0) {
    bytes.push(24);
    remaining = BigInt(stream.partition);
    while (remaining >= 128n) {
      bytes.push(Number(remaining & 127n) | 128);
      remaining >>= 7n;
    }
    bytes.push(Number(remaining));
  }
  return metricStreamPosition(stream, MessageId.deserialize(Buffer.from(bytes)));
}

export function analyticsEffect(
  position: PulsarMetricStreamPosition,
  ordinal: bigint,
  userId: string,
): AnalyticsEffect & {
  position: PulsarMetricStreamPosition;
  cursor: { delivery: PulsarMetricStreamPosition["delivery"]; effectOrdinal: string };
} {
  const sourceId = randomUUID();
  return {
    stream: {
      transport: position.transport,
      epoch: position.epoch,
      topic: position.topic,
      partition: position.partition,
    },
    position,
    cursor: { delivery: position.delivery, effectOrdinal: String(ordinal) },
    stage: "scalar",
    operationId: null,
    sourceId,
    sourceVersion: "9007199254740993",
    generation: "0",
    before: null,
    after: {
      sourceId,
      userId,
      providerId: "test",
      sourceVersion: "9007199254740993",
      generation: "0",
      key: { userId, channel: "heart_rate", recordedAt: "2026-11-03T00:00:00.123456789Z" },
      activityId: null,
      deleted: false,
    },
  };
}

import { Readable } from "node:stream";
import type { createClient } from "@clickhouse/client";
