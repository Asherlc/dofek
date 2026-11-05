import Pulsar from "pulsar-client";
import {
  metricStreamPosition,
  type PulsarMetricStreamPosition,
} from "../metric-stream/transport-position.ts";
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

import { Readable } from "node:stream";
import type { createClient } from "@clickhouse/client";
