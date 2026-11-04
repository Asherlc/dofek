import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const METRIC_STREAM_EVENT_VERSION = 2;
export const METRIC_STREAM_DELETE_EVENT_VERSION = 3;
export const METRIC_STREAM_DELETED_EVENT_TYPE = "metric_stream_deleted";
export const METRIC_STREAM_BATCH_COMPLETED_EVENT_TYPE = "metric_stream_batch_completed";
export const METRIC_STREAM_PROVIDER_GENERATION_DELETED_EVENT_TYPE =
  "metric_stream_provider_generation_deleted";

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
  const normalized = date.toISOString();
  // Date normalizes the timezone, but its millisecond precision must not erase
  // finer source/scope boundaries that the canonical DateTime64(6) preserves.
  const fraction =
    typeof value === "string" ? /\.(\d{4,})(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value)?.[1] : undefined;
  return fraction
    ? normalized.replace(/\.\d{3}Z$/, `.${fraction.replace(/0+$/, "").padEnd(3, "0")}Z`)
    : normalized;
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

export const metricStreamProviderGenerationDeletedEventSchema = z
  .object({
    version: z.literal(1),
    eventType: z.literal(METRIC_STREAM_PROVIDER_GENERATION_DELETED_EVENT_TYPE),
    commandId: z.uuid(),
    deletionEventId: z.uuid(),
    userId: z.uuid(),
    providerId: nonEmptyStringSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceIds: z.array(z.uuid()).max(1000),
    complete: z.boolean(),
    previousCommandId: z.uuid().nullable(),
    partitionKey: nonEmptyStringSchema,
  })
  .strict()
  .superRefine((command, context) => {
    const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (command.partitionKey !== `provider-generation:${command.userId}:${command.providerId}`)
      invalid("Provider generation command requires its fixed owner/provider partition key");
    if (
      command.commandId !==
      providerGenerationCommandId(command.deletionEventId, command.previousCommandId)
    )
      invalid("Provider generation command must use its canonical deletion/predecessor slot");
    if (
      command.commandId === command.deletionEventId ||
      command.commandId === command.previousCommandId
    )
      invalid(
        "Provider generation command identity must be distinct from deletion and predecessor identities",
      );
    if (new Set(command.sourceIds).size !== command.sourceIds.length)
      invalid("Provider generation command source IDs must be unique");
    if (command.previousCommandId === null && (command.complete || command.sourceIds.length))
      invalid("The first provider generation command must be fence-only");
    if (
      command.previousCommandId !== null &&
      (command.complete ? command.sourceIds.length > 0 : command.sourceIds.length === 0)
    )
      invalid("Provider generation pages require IDs and terminal commands require an empty page");
  });

export const metricStreamRedpandaEventSchema = z.union([
  metricStreamDeletedEventV1Schema,
  metricStreamDeletedEventV2Schema,
  metricStreamDeletedEventV3Schema,
  metricStreamBatchCompletedEventV1Schema,
  metricStreamProviderGenerationDeletedEventSchema,
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
export type MetricStreamProviderGenerationDeletedEvent = z.infer<
  typeof metricStreamProviderGenerationDeletedEventSchema
>;

export function createMetricStreamProviderGenerationDeletedEvent(
  input: Omit<
    MetricStreamProviderGenerationDeletedEvent,
    "version" | "eventType" | "partitionKey" | "commandId"
  >,
): MetricStreamProviderGenerationDeletedEvent {
  return metricStreamProviderGenerationDeletedEventSchema.parse({
    ...input,
    commandId: providerGenerationCommandId(input.deletionEventId, input.previousCommandId),
    version: 1,
    eventType: METRIC_STREAM_PROVIDER_GENERATION_DELETED_EVENT_TYPE,
    partitionKey: `provider-generation:${input.userId}:${input.providerId}`,
  });
}

export function isMetricStreamProviderGenerationDeletedEvent(
  event: MetricStreamRedpandaEvent,
): event is MetricStreamProviderGenerationDeletedEvent {
  return (
    "eventType" in event && event.eventType === METRIC_STREAM_PROVIDER_GENERATION_DELETED_EVENT_TYPE
  );
}

function formatUuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byteValue) => byteValue.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}

function formatUuidV5Digest(digest: Uint8Array): string {
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

function providerGenerationCommandId(deletionEventId: string, previousCommandId: string | null) {
  const name = JSON.stringify([
    deletionEventId.toLowerCase(),
    previousCommandId?.toLowerCase() ?? null,
  ]);
  return formatUuidV5Digest(
    createHash("sha1")
      .update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
      .update(`dofek.provider-generation-command.v1:${name}`)
      .digest(),
  );
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
    // Source precision is emitted separately; historical implicit IDs hash UTC milliseconds.
    .update(new Date(row.recordedAt).toISOString());
  const metadata = row.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    typeof metadata.interval_end === "string"
  ) {
    hash.update("\0interval_end:").update(new Date(metadata.interval_end).toISOString());
    hash.update("\0source_type:").update(row.sourceType);
    hash
      .update("\0source_bundle:")
      .update(typeof metadata.source_bundle === "string" ? metadata.source_bundle : "");
  }
  if (row.generation > 0) {
    hash.update("\0generation:").update(String(row.generation));
  }
  return formatUuidV5Digest(hash.digest());
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
