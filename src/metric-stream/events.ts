import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const METRIC_STREAM_EVENT_VERSION = 2;
export const METRIC_STREAM_DELETE_EVENT_VERSION = 3;
export const METRIC_STREAM_DELETED_EVENT_TYPE = "metric_stream_deleted";
export const METRIC_STREAM_BATCH_COMPLETED_EVENT_TYPE = "metric_stream_batch_completed";

const nonEmptyStringSchema = z.string().min(1);
const optionalNullableTextSchema = nonEmptyStringSchema.nullable().optional();
const generationSchema = z.number().int().nonnegative().default(0);
export const metricStreamOperationRevisionSchema = z.string().regex(/^[1-9]\d*$/);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
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
    id: z.guid().optional(),
    recordedAt: timestampInputSchema,
    userId: z.guid(),
    providerId: nonEmptyStringSchema,
    generation: generationSchema,
    externalId: optionalNullableTextSchema,
    deviceId: optionalNullableTextSchema,
    sourceType: nonEmptyStringSchema,
    channel: nonEmptyStringSchema,
    activityId: z.guid().nullable().optional(),
    scalar: z.number().finite().nullable().optional(),
    vector: z.array(z.number().finite()).min(1).nullable().optional(),
    point: optionalNullableTextSchema,
    metadata: jsonValueSchema.optional(),
  })
  .strict();

export const metricStreamEventV1Schema = z
  .object({
    version: z.literal(1),
    id: z.guid(),
    recordedAt: z.string().datetime({ offset: true }),
    userId: z.guid(),
    providerId: nonEmptyStringSchema,
    generation: generationSchema,
    externalId: optionalNullableTextSchema,
    deviceId: optionalNullableTextSchema,
    sourceType: nonEmptyStringSchema,
    channel: nonEmptyStringSchema,
    activityId: z.guid().nullable().optional(),
    scalar: z.number().finite().nullable().optional(),
    vector: z.array(z.number().finite()).min(1).nullable().optional(),
    point: optionalNullableTextSchema,
    metadata: jsonValueSchema.optional(),
  })
  .strict();

export const metricStreamEventV2Schema = metricStreamEventV1Schema
  .omit({ version: true })
  .extend({
    version: z.literal(METRIC_STREAM_EVENT_VERSION),
    operationRevision: metricStreamOperationRevisionSchema,
  })
  .strict();

export const metricStreamDeleteScopeSchema = z
  .object({
    userId: z.guid().optional(),
    providerId: nonEmptyStringSchema.optional(),
    externalId: optionalNullableTextSchema,
    channel: nonEmptyStringSchema.optional(),
    activityId: z.guid().optional(),
    recordedAtStart: timestampInputSchema.optional(),
    recordedAtEnd: timestampInputSchema.optional(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (!scope.userId && !scope.activityId && !scope.providerId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Metric stream delete scope must include userId, activityId, or providerId",
      });
    }
  });

export const metricStreamDeletedEventV1Schema = z
  .object({
    version: z.literal(1),
    eventType: z.literal(METRIC_STREAM_DELETED_EVENT_TYPE),
    scope: metricStreamDeleteScopeSchema,
    partitionKey: nonEmptyStringSchema,
  })
  .strict();

export const metricStreamDeletedEventV2Schema = z
  .object({
    version: z.literal(2),
    eventType: z.literal(METRIC_STREAM_DELETED_EVENT_TYPE),
    eventId: z.uuid(),
    scope: metricStreamDeleteScopeSchema,
    partitionKey: nonEmptyStringSchema,
  })
  .strict();

export const metricStreamDeletedEventV3Schema = metricStreamDeletedEventV2Schema
  .omit({ version: true })
  .extend({
    version: z.literal(METRIC_STREAM_DELETE_EVENT_VERSION),
    operationRevision: metricStreamOperationRevisionSchema,
  })
  .strict();

export const metricStreamProcessingContextSchema = z
  .object({
    operationId: z.uuid(),
    batchId: nonEmptyStringSchema,
    datasetKeys: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();

export const metricStreamBatchCompletedEventV1Schema = metricStreamProcessingContextSchema
  .extend({
    version: z.literal(1),
    eventType: z.literal(METRIC_STREAM_BATCH_COMPLETED_EVENT_TYPE),
    expectedEventCount: z.number().int().positive(),
    partitionKey: nonEmptyStringSchema,
  })
  .strict();

export const metricStreamRedpandaEventSchema = z.union([
  metricStreamDeletedEventV1Schema,
  metricStreamDeletedEventV2Schema,
  metricStreamDeletedEventV3Schema,
  metricStreamBatchCompletedEventV1Schema,
  metricStreamEventV1Schema,
  metricStreamEventV2Schema,
]);

export type MetricStreamRowInput = z.input<typeof metricStreamRowInputSchema>;
export type MetricStreamEventV1 = z.infer<typeof metricStreamEventV1Schema>;
export type MetricStreamEventV2 = z.infer<typeof metricStreamEventV2Schema>;
export type MetricStreamRowEvent = MetricStreamEventV1 | MetricStreamEventV2;
export type MetricStreamDeleteScopeInput = z.input<typeof metricStreamDeleteScopeSchema>;
export type MetricStreamDeleteScope = z.infer<typeof metricStreamDeleteScopeSchema>;
export type MetricStreamDeletedEventV1 = z.infer<typeof metricStreamDeletedEventV1Schema>;
export type MetricStreamDeletedEventV2 = z.infer<typeof metricStreamDeletedEventV2Schema>;
export type MetricStreamDeletedEventV3 = z.infer<typeof metricStreamDeletedEventV3Schema>;
export type MetricStreamDeletedEvent =
  | MetricStreamDeletedEventV1
  | MetricStreamDeletedEventV2
  | MetricStreamDeletedEventV3;
export type MetricStreamProcessingContext = z.input<typeof metricStreamProcessingContextSchema>;
export type MetricStreamBatchCompletedEventV1 = z.infer<
  typeof metricStreamBatchCompletedEventV1Schema
>;
export type MetricStreamRedpandaEvent = z.infer<typeof metricStreamRedpandaEventSchema>;

function formatUuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byteValue) => byteValue.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}

function createDeterministicMetricStreamId(
  row: z.output<typeof metricStreamRowInputSchema>,
): string {
  if (row.externalId === null || row.externalId === undefined) {
    throw new Error("Metric stream rows without id must include externalId");
  }

  const hash = createHash("sha1")
    .update("dofek.metric-stream.v1")
    .update("\0")
    .update(row.userId)
    .update("\0")
    .update(row.providerId)
    .update("\0")
    .update(row.externalId)
    .update("\0")
    .update(row.channel)
    .update("\0")
    .update(row.recordedAt);
  if (row.generation > 0) {
    hash.update("\0generation:").update(String(row.generation));
  }
  const digest = hash.digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Metric stream deterministic id hash is too short");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  return formatUuidFromBytes(bytes);
}

export function createMetricStreamEvent(
  row: MetricStreamRowInput,
  operationRevision: string,
): MetricStreamEventV2 {
  const parsedRow = metricStreamRowInputSchema.parse(row);
  return metricStreamEventV2Schema.parse({
    version: METRIC_STREAM_EVENT_VERSION,
    operationRevision,
    id: parsedRow.id ?? createDeterministicMetricStreamId(parsedRow),
    recordedAt: parsedRow.recordedAt,
    userId: parsedRow.userId,
    providerId: parsedRow.providerId,
    generation: parsedRow.generation,
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

export function createMetricStreamDeletePartitionKey(
  scopeInput: MetricStreamDeleteScopeInput,
): string {
  const scope = metricStreamDeleteScopeSchema.parse(scopeInput);
  if (scope.activityId) {
    return `activity:${scope.activityId}`;
  }
  if (scope.userId && !scope.providerId) {
    return `account:${scope.userId}`;
  }
  return [
    "provider",
    scope.userId ?? "*",
    scope.providerId ?? "*",
    scope.externalId ?? "*",
    scope.channel ?? "*",
    scope.recordedAtStart ?? "*",
    scope.recordedAtEnd ?? "*",
  ].join(":");
}

export function createMetricStreamDeletedEvent(
  scope: MetricStreamDeleteScopeInput,
  operationRevision: string,
): MetricStreamDeletedEventV3 {
  const parsedScope = metricStreamDeleteScopeSchema.parse(scope);
  return metricStreamDeletedEventV3Schema.parse({
    version: METRIC_STREAM_DELETE_EVENT_VERSION,
    eventType: METRIC_STREAM_DELETED_EVENT_TYPE,
    eventId: randomUUID(),
    operationRevision,
    scope: parsedScope,
    partitionKey: createMetricStreamDeletePartitionKey(parsedScope),
  });
}

export function createMetricStreamBatchPartitionKey(
  contextInput: MetricStreamProcessingContext,
): string {
  const context = metricStreamProcessingContextSchema.parse(contextInput);
  return `processing:${context.operationId}:${context.batchId}`;
}

export function createMetricStreamBatchCompletedEvent(
  contextInput: MetricStreamProcessingContext,
  expectedEventCount: number,
  partitionKey = createMetricStreamBatchPartitionKey(contextInput),
): MetricStreamBatchCompletedEventV1 {
  const context = metricStreamProcessingContextSchema.parse(contextInput);
  return metricStreamBatchCompletedEventV1Schema.parse({
    ...context,
    version: 1,
    eventType: METRIC_STREAM_BATCH_COMPLETED_EVENT_TYPE,
    expectedEventCount,
    partitionKey,
  });
}

export function isMetricStreamDeletedEvent(
  event: MetricStreamRedpandaEvent,
): event is MetricStreamDeletedEvent {
  return "eventType" in event && event.eventType === METRIC_STREAM_DELETED_EVENT_TYPE;
}

export function isMetricStreamBatchCompletedEvent(
  event: MetricStreamRedpandaEvent,
): event is MetricStreamBatchCompletedEventV1 {
  return "eventType" in event && event.eventType === METRIC_STREAM_BATCH_COMPLETED_EVENT_TYPE;
}
