import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";
import { type AnalyticsStream, metricStreamPositionIdentity } from "./journal-position.ts";

export interface AnalyticsDeliveryGroup {
  stream: AnalyticsStream;
  first: MetricStreamPosition;
  last: MetricStreamPosition;
  memberCount: number;
  positionsDigest: string;
}

export interface PersistedAnalyticsDeliveryGroup extends AnalyticsDeliveryGroup {
  ingestedAt: string;
  intentId: string;
}

export function analyticsDeliveryGroupIntentId(group: AnalyticsDeliveryGroup): string {
  return `source-group:${group.positionsDigest}`;
}

export function analyticsDeliveryGroupIngestionTimes(
  baseUtcMicroseconds: string,
  count: number,
): readonly string[] {
  z.object({
    baseUtcMicroseconds: z.iso.datetime({ precision: 6 }),
    count: z.number().int().min(1).max(500),
  }).parse({ baseUtcMicroseconds, count });
  const wholeSecond = Date.parse(`${baseUtcMicroseconds.slice(0, 19)}Z`);
  const base = BigInt(wholeSecond) * 1000n + BigInt(baseUtcMicroseconds.slice(20, 26));
  return Array.from({ length: count }, (_, ordinal) => {
    const microseconds = base + BigInt(ordinal);
    const fraction = ((microseconds % 1000000n) + 1000000n) % 1000000n;
    const second = new Date(Number((microseconds - fraction) / 1000n)).toISOString();
    const timestamp = `${second.slice(0, 19)}.${String(fraction).padStart(6, "0")}Z`;
    return z.object({ timestamp: z.iso.datetime({ precision: 6 }) }).parse({ timestamp }).timestamp;
  });
}

export function describeAnalyticsDeliveryGroup(
  positions: readonly MetricStreamPosition[],
  maximum: number,
): AnalyticsDeliveryGroup {
  z.object({ maximum: z.number().int().min(1).max(500) }).parse({ maximum });
  const { positions: members } = z
    .object({ positions: z.array(metricStreamPositionSchema).min(1).max(maximum) })
    .parse({ positions });
  const first = members[0];
  const last = members.at(-1);
  if (!first || !last) throw new Error("An analytics delivery group requires at least one member");
  const stream = {
    transport: first.transport,
    epoch: first.epoch,
    topic: first.topic,
    partition: first.partition,
  };
  let previous: MetricStreamPosition | null = null;
  const nativeIdentities = new Set<string>();
  const identities: (string | number)[][] = [
    [stream.transport, stream.epoch, stream.topic, stream.partition],
  ];
  for (const position of members) {
    if (previous && compareMetricStreamPositions(previous, position) >= 0)
      throw new Error("Analytics delivery group members must preserve strict native order");
    const nativeIdentity = metricStreamPositionIdentity(position);
    if (nativeIdentities.has(nativeIdentity))
      throw new Error("Analytics delivery group contains a duplicate native message identity");
    nativeIdentities.add(nativeIdentity);
    identities.push(
      position.transport === "kafka"
        ? [position.offset]
        : [
            position.delivery.major,
            position.delivery.minor,
            position.delivery.batch,
            position.serializedMessageId,
          ],
    );
    previous = position;
  }
  return {
    stream,
    first,
    last,
    memberCount: members.length,
    positionsDigest: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
  };
}
