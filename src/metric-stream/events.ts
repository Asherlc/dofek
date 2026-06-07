import { randomUUID } from "node:crypto";
import { z } from "zod";

export const METRIC_STREAM_EVENT_VERSION = 1;

const nonEmptyStringSchema = z.string().min(1);
const optionalNullableTextSchema = nonEmptyStringSchema.nullable().optional();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const timestampInputSchema = z.union([z.string().min(1), z.date()]).transform((value, context) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "recordedAt must be a valid timestamp",
    });
    return z.NEVER;
  }
  return date.toISOString();
});

export const metricStreamRowInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    recordedAt: timestampInputSchema,
    userId: z.string().uuid(),
    providerId: nonEmptyStringSchema,
    externalId: optionalNullableTextSchema,
    deviceId: optionalNullableTextSchema,
    sourceType: nonEmptyStringSchema,
    channel: nonEmptyStringSchema,
    activityId: z.string().uuid().nullable().optional(),
    scalar: z.number().finite().nullable().optional(),
    vector: z.array(z.number().finite()).min(1).nullable().optional(),
    point: optionalNullableTextSchema,
    metadata: jsonValueSchema.optional(),
  })
  .strict();

export const metricStreamEventV1Schema = z
  .object({
    version: z.literal(METRIC_STREAM_EVENT_VERSION),
    id: z.string().uuid(),
    recordedAt: z.string().datetime({ offset: true }),
    userId: z.string().uuid(),
    providerId: nonEmptyStringSchema,
    externalId: optionalNullableTextSchema,
    deviceId: optionalNullableTextSchema,
    sourceType: nonEmptyStringSchema,
    channel: nonEmptyStringSchema,
    activityId: z.string().uuid().nullable().optional(),
    scalar: z.number().finite().nullable().optional(),
    vector: z.array(z.number().finite()).min(1).nullable().optional(),
    point: optionalNullableTextSchema,
    metadata: jsonValueSchema.optional(),
  })
  .strict();

export type MetricStreamRowInput = z.input<typeof metricStreamRowInputSchema>;
export type MetricStreamEventV1 = z.infer<typeof metricStreamEventV1Schema>;

export function createMetricStreamEvent(row: MetricStreamRowInput): MetricStreamEventV1 {
  const parsedRow = metricStreamRowInputSchema.parse(row);
  return metricStreamEventV1Schema.parse({
    version: METRIC_STREAM_EVENT_VERSION,
    id: parsedRow.id ?? randomUUID(),
    recordedAt: parsedRow.recordedAt,
    userId: parsedRow.userId,
    providerId: parsedRow.providerId,
    externalId: parsedRow.externalId ?? null,
    deviceId: parsedRow.deviceId ?? null,
    sourceType: parsedRow.sourceType,
    channel: parsedRow.channel,
    activityId: parsedRow.activityId ?? null,
    scalar: parsedRow.scalar ?? null,
    vector: parsedRow.vector ?? null,
    point: parsedRow.point ?? null,
    metadata: parsedRow.metadata ?? null,
  });
}
