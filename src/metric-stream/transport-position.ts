import { z } from "zod";

const nativeCoordinateSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

export const metricStreamPositionSchema = z.strictObject({
  transport: z.literal("kafka"),
  epoch: z.string().min(1),
  topic: z.string().min(1),
  partition: z.number().int().nonnegative().max(2147483647),
  offset: nativeCoordinateSchema,
});

export type MetricStreamPosition = z.infer<typeof metricStreamPositionSchema>;

export function compareMetricStreamPositions(
  left: MetricStreamPosition,
  right: MetricStreamPosition,
): number {
  metricStreamPositionSchema.parse(left);
  metricStreamPositionSchema.parse(right);
  if (
    left.epoch !== right.epoch ||
    left.topic !== right.topic ||
    left.partition !== right.partition
  ) {
    throw new Error("Metric-stream positions must share epoch, topic, and partition");
  }
  const leftOffset = BigInt(left.offset);
  const rightOffset = BigInt(right.offset);
  if (leftOffset === rightOffset) return 0;
  return leftOffset < rightOffset ? -1 : 1;
}
