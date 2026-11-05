import { ACTIVITY_MODALITIES, CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import { z } from "zod";
import type {
  CdcAdmissionIdentity,
  CdcDeliveryEvidence,
  CdcTransactionEnd,
  CdcTransactionRow,
} from "./cdc-admission.ts";

// This decoder checks configured source identity, not slot/restore incarnation.
// The bootstrap caller must admit one lineage per generation and validate native
// MetricStreamPosition separately. The synthetic 2147483648 fixture is outside
// current ClickHouse Int32 destinations: a reviewed new-generation Int64 mapping
// is mandatory before writes; this decoder neither writes nor qualifies it.
// Pinned convertString returns the placeholder as the whole column value:
// https://github.com/debezium/debezium/blob/v3.7.0.Final/debezium-connector-postgres/src/main/java/io/debezium/connector/postgresql/PostgresValueConverter.java#L1648-L1652
const text = z
  .string()
  .refine((v) => v !== "__debezium_unavailable_value", "Unavailable source value");
const uuid = text.uuid();
const long = z
  .bigint()
  .refine((v) => v >= -(1n << 63n) && v < 1n << 63n)
  .transform(String);
const int = long.refine((v) => BigInt(v) >= -(1n << 31n) && BigInt(v) < 1n << 31n);
const ordinal = long.refine((v) => BigInt(v) > 0n);
const timestamp = text.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/);
const idKey = z.strictObject({ id: uuid });
const providerKey = z.strictObject({ provider_id: text });
const fieldKey = providerKey.extend({ field_key: text });
const deviceKey = providerKey.extend({ source_name_pattern: text });
const sensorKey = providerKey.extend({ channel: text });
const sensorDeviceKey = deviceKey.extend({ channel: text });
const priorities = {
  priority: int.nullable(),
  sleep_priority: int.nullable(),
  body_priority: int.nullable(),
  recovery_priority: int.nullable(),
  daily_activity_priority: int.nullable(),
};
const schemas = {
  activity: idKey.extend({
    provider_id: text,
    user_id: uuid,
    external_id: text,
    provider_type: text,
    canonical_type: z.enum(CANONICAL_ACTIVITY_TYPES),
    modality: z.enum(ACTIVITY_MODALITIES).nullable(),
    started_at: timestamp,
    ended_at: timestamp.nullable(),
    name: text.nullable(),
    notes: text.nullable(),
    perceived_exertion: z
      .union([z.number().min(0).max(10), z.bigint().min(0n).max(10n).transform(Number)])
      .nullable(),
    source_name: text.nullable(),
    timezone: text.nullable(),
    start_utc_offset_minutes: long.nullable(),
    end_utc_offset_minutes: long.nullable(),
    local_time_source: text,
    strava_id: text.nullable(),
    raw: text.nullable(),
    provider_absent_at: timestamp.nullable(),
    deleted_at: timestamp.nullable(),
    created_at: timestamp,
    rejected_provider_timezone: text.nullable(),
    rejected_provider_start_utc_offset_minutes: long.nullable(),
    rejected_provider_end_utc_offset_minutes: long.nullable(),
    group_id: uuid,
    absence_provider_id: text.nullable(),
  }),
  provider_priority: providerKey.extend({ ...priorities, priority: int }),
  provider_field_priority: fieldKey.extend({ priority: long }),
  device_priority: deviceKey.extend(priorities),
  sensor_provider_priority: sensorKey.extend({ priority: long }),
  sensor_device_priority: sensorDeviceKey.extend({ priority: long }),
  processing_flow_marker: idKey.extend({
    operation_id: uuid,
    dataset_key: text,
    flow_name: text,
    batch_key: text,
    source_watermark: text,
    created_at: timestamp,
  }),
};
const keys = {
  activity: idKey,
  provider_priority: providerKey,
  provider_field_priority: fieldKey,
  device_priority: deviceKey,
  sensor_provider_priority: sensorKey,
  sensor_device_priority: sensorDeviceKey,
  processing_flow_marker: idKey,
};
const tableSchema = z.enum([
  "activity",
  "provider_priority",
  "provider_field_priority",
  "device_priority",
  "sensor_provider_priority",
  "sensor_device_priority",
  "processing_flow_marker",
]);
type Table = z.infer<typeof tableSchema>;
type Owner =
  | { kind: "direct-user"; userId: string }
  | { kind: "inherited"; parentTable: "fitness.processing_operation"; key: { id: string } }
  | { kind: "shared-system" };
const directOwner = z.strictObject({ kind: z.literal("direct-user"), userId: uuid });
const inheritedOwner = z.strictObject({
  kind: z.literal("inherited"),
  parentTable: z.literal("fitness.processing_operation"),
  key: idKey,
});
const sharedOwner = z.strictObject({ kind: z.literal("shared-system") });
const scopeSchema = z.discriminatedUnion("table", [
  z.strictObject({
    table: z.literal("activity"),
    fields: schemas.activity,
    key: idKey,
    owner: directOwner,
  }),
  z.strictObject({
    table: z.literal("provider_priority"),
    fields: schemas.provider_priority,
    key: providerKey,
    owner: sharedOwner,
  }),
  z.strictObject({
    table: z.literal("provider_field_priority"),
    fields: schemas.provider_field_priority,
    key: fieldKey,
    owner: sharedOwner,
  }),
  z.strictObject({
    table: z.literal("device_priority"),
    fields: schemas.device_priority,
    key: deviceKey,
    owner: sharedOwner,
  }),
  z.strictObject({
    table: z.literal("sensor_provider_priority"),
    fields: schemas.sensor_provider_priority,
    key: sensorKey,
    owner: sharedOwner,
  }),
  z.strictObject({
    table: z.literal("sensor_device_priority"),
    fields: schemas.sensor_device_priority,
    key: sensorDeviceKey,
    owner: sharedOwner,
  }),
  z.strictObject({
    table: z.literal("processing_flow_marker"),
    fields: schemas.processing_flow_marker,
    key: idKey,
    owner: inheritedOwner,
  }),
]);
type Scope = z.infer<typeof scopeSchema>;
type Key = Scope["key"];
interface Source extends CdcAdmissionIdentity {
  topicPrefix: string;
  connectorName: string;
  database: string;
}
type Images = { before: Scope | null; after: Scope | null; oldKey: Key | null; newKey: Key | null };
type Decoded =
  | (CdcTransactionRow & Images & { operation: "c" | "u" | "d" })
  | CdcTransactionEnd
  | (CdcAdmissionIdentity & {
      kind: "snapshot";
      operation: "r";
      sourceRevision: "0";
      delivery: CdcDeliveryEvidence;
    } & Images)
  | (CdcAdmissionIdentity & { kind: "begin"; transactionId: string; delivery: CdcDeliveryEvidence })
  | (CdcAdmissionIdentity & {
      kind: "notification";
      notification: z.infer<typeof notificationSchema>;
      delivery: CdcDeliveryEvidence;
    })
  | (CdcAdmissionIdentity & {
      kind: "tombstone";
      table: Table;
      key: Key;
      delivery: CdcDeliveryEvidence;
    });
const object = z.record(z.string(), z.unknown());
function parse(data: string): unknown {
  return JSON.parse(data, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined && /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
}
function scope(table: Table, value: unknown): Scope | null {
  if (value === null) return null;
  const fields = schemas[table].parse(value);
  const key = keys[table].parse(
    Object.fromEntries(
      Object.keys(keys[table].shape).map((name) => [name, object.parse(fields)[name]]),
    ),
  );
  const owner: Owner =
    "user_id" in fields
      ? { kind: "direct-user", userId: fields.user_id }
      : "operation_id" in fields
        ? {
            kind: "inherited",
            parentTable: "fitness.processing_operation",
            key: { id: fields.operation_id },
          }
        : { kind: "shared-system" };
  // table selects both closed schemas above; there is no unchecked field decoding.
  return scopeSchema.parse({ table, fields: value, key, owner });
}
const collectionName = text.refine(
  (name) =>
    name.startsWith("fitness.") && tableSchema.safeParse(name.slice("fitness.".length)).success,
  "Unknown CDC collection",
);
const notificationSchema = z.strictObject({
  id: uuid,
  type: z.enum([
    "STARTED",
    "DATA_COLLECTIONS_RESOLVED",
    "IN_PROGRESS",
    "TABLE_SCAN_COMPLETED",
    "COMPLETED",
  ]),
  aggregate_type: z.literal("Initial Snapshot"),
  additional_data: z.strictObject({
    connector_name: text,
    data_collections: text
      .refine((list) => list.split(",").every((name) => collectionName.safeParse(name).success))
      .optional(),
    current_collection_in_progress: collectionName.optional(),
    scanned_collection: collectionName.optional(),
    total_rows_scanned: text.regex(/^(0|[1-9]\d*)$/).optional(),
    status: z.literal("SUCCEEDED").optional(),
  }),
  timestamp: long,
});
const transactionSchema = z.strictObject({
  id: text.regex(/^[1-9]\d*:-?\d+$/),
  total_order: ordinal,
  data_collection_order: ordinal,
});
const sourceSchema = z.strictObject({
  version: z.literal("3.7.0.Final"),
  connector: z.literal("postgresql"),
  name: text,
  ts_ms: long,
  snapshot: z.enum(["first", "last", "last_in_data_collection", "true", "false"]),
  db: text,
  sequence: text,
  ts_us: long,
  ts_ns: long,
  schema: z.literal("fitness"),
  table: tableSchema,
  txId: ordinal,
  lsn: long,
  xmin: long.nullable(),
  origin: text.nullable(),
  origin_lsn: long.nullable(),
});
const envelopeSchema = z.strictObject({
  before: z.unknown(),
  after: z.unknown(),
  source: sourceSchema,
  op: z.enum(["r", "c", "u", "d"]),
  ts_ms: long,
  ts_us: long,
  ts_ns: long,
  transaction: transactionSchema.nullable(),
});

/** Pure first-slice decoder. END admission alone assigns streaming revisions;
 * BEGIN, notifications and tombstones are evidence, never completion/frontiers.
 * The future handler must buffer across receive groups/topics until END coverage.
 */
export function decodeFitnessCdc(source: Source, delivery: CdcDeliveryEvidence): Decoded {
  if (
    !source.generation ||
    !source.lineage ||
    !source.database ||
    !source.connectorName ||
    !source.topicPrefix
  )
    throw new Error("Missing admitted CDC source identity");
  const value = parse(new TextDecoder("utf-8", { fatal: true }).decode(delivery.data));
  const keyValue = parse(z.string().parse(delivery.key));
  if (delivery.topic === `${source.topicPrefix}-notifications`) {
    const notification = notificationSchema.parse(value);
    if (
      notification.additional_data.connector_name !== source.connectorName ||
      idKey.parse(keyValue).id !== notification.id
    )
      throw new Error("Snapshot notification identity mismatch");
    return {
      kind: "notification",
      generation: source.generation,
      lineage: source.lineage,
      notification,
      delivery,
    };
  }
  if (delivery.topic === `${source.topicPrefix}.transaction`) {
    const tx = z
      .strictObject({
        status: z.enum(["BEGIN", "END"]),
        id: transactionSchema.shape.id,
        event_count: long.nullable(),
        data_collections: z
          .array(z.strictObject({ data_collection: text, event_count: long }))
          .nullable(),
        ts_ms: long,
      })
      .parse(value);
    if (z.strictObject({ id: text }).parse(keyValue).id !== tx.id)
      throw new Error("Transaction key mismatch");
    if (tx.status === "BEGIN") {
      if (tx.event_count !== null || tx.data_collections !== null)
        throw new Error("Malformed BEGIN");
      return {
        kind: "begin",
        generation: source.generation,
        lineage: source.lineage,
        transactionId: tx.id,
        delivery,
      };
    }
    if (tx.event_count === null || tx.data_collections === null)
      throw new Error("Missing END counts");
    const collections = tx.data_collections.map((entry) => {
      tableSchema.parse(entry.data_collection.replace(/^fitness\./, ""));
      if (!entry.data_collection.startsWith("fitness.")) throw new Error("Unknown END collection");
      return { collection: entry.data_collection, eventCount: entry.event_count };
    });
    return {
      kind: "end",
      generation: source.generation,
      lineage: source.lineage,
      transactionId: tx.id,
      eventCount: tx.event_count,
      collections,
      delivery,
    };
  }
  const table = tableSchema.parse(
    delivery.topic.startsWith(`${source.topicPrefix}.fitness.`)
      ? delivery.topic.slice(`${source.topicPrefix}.fitness.`.length)
      : undefined,
  );
  const key = keys[table].parse(keyValue);
  if (value === null)
    return {
      kind: "tombstone",
      generation: source.generation,
      lineage: source.lineage,
      table,
      key,
      delivery,
    };
  const envelope = envelopeSchema.parse(value);
  const native = envelope.source;
  if (
    native.name !== source.connectorName ||
    native.db !== source.database ||
    native.table !== table
  )
    throw new Error("Configured CDC source mismatch");
  const before = scope(table, envelope.before),
    after = scope(table, envelope.after);
  if (
    envelope.op === "r" || envelope.op === "c"
      ? before !== null || after === null
      : envelope.op === "d"
        ? before === null || after !== null
        : before === null || after === null
  )
    throw new Error("Missing or invalid full row images");
  for (const image of [before, after])
    if (image && JSON.stringify(image.key) !== JSON.stringify(key))
      throw new Error("Native key differs from row identity");
  function header(name: string): Key | null {
    const raw = delivery.properties[name];
    if (raw === undefined) return null;
    const wrapped = z
      .strictObject({
        schema: z.strictObject({
          type: z.literal("struct"),
          optional: z.literal(false),
          name: text,
          fields: z.array(
            z.strictObject({
              type: z.literal("string"),
              optional: z.literal(false),
              field: text,
              name: text.optional(),
              version: long.optional(),
              default: text.optional(),
            }),
          ),
        }),
        payload: z.unknown(),
      })
      .parse(parse(raw));
    const expectedFields = Object.keys(keys[table].shape);
    if (
      JSON.stringify(wrapped.schema.fields.map((field) => field.field)) !==
      JSON.stringify(expectedFields)
    )
      throw new Error("Structural header key fields mismatch");
    for (const field of wrapped.schema.fields) {
      if (
        field.field === "id"
          ? field.name !== "io.debezium.data.Uuid" ||
            field.version !== "1" ||
            field.default !== "00000000-0000-0000-0000-000000000000"
          : field.name !== undefined || field.version !== undefined || field.default !== undefined
      )
        throw new Error("Unknown structural key field schema");
    }
    if (wrapped.schema.name !== `${source.connectorName}.fitness.${table}.Key`)
      throw new Error("Structural header schema mismatch");
    return keys[table].parse(wrapped.payload);
  }
  const images = {
    before,
    after,
    oldKey: header("__debezium.oldkey"),
    newKey: header("__debezium.newkey"),
  };
  if (envelope.op === "r") {
    if (native.snapshot === "false" || envelope.transaction !== null)
      throw new Error("Invalid snapshot identity");
    return {
      kind: "snapshot",
      operation: "r",
      sourceRevision: "0",
      generation: source.generation,
      lineage: source.lineage,
      delivery,
      ...images,
    };
  }
  const tx = envelope.transaction;
  if (tx === null) throw new Error("Missing streaming transaction metadata");
  if (
    native.snapshot !== "false" ||
    tx.id.split(":")[0] !== native.txId ||
    tx.id.split(":")[1] !== native.lsn
  )
    throw new Error("Streaming transaction identity mismatch");
  return {
    kind: "row",
    operation: envelope.op,
    generation: source.generation,
    lineage: source.lineage,
    xid: native.txId,
    rowLsn: native.lsn,
    transactionId: tx.id,
    ordinal: tx.total_order,
    collectionOrdinal: tx.data_collection_order,
    collection: `fitness.${table}`,
    stablePayload: JSON.stringify({
      op: envelope.op,
      before: before?.fields ?? null,
      after: after?.fields ?? null,
      source: { schema: native.schema, table, txId: native.txId, lsn: native.lsn },
      transaction: tx,
      key,
      oldKey: images.oldKey,
      newKey: images.newKey,
      structuralHeaders: Object.fromEntries(
        ["__debezium.oldkey", "__debezium.newkey"]
          .filter((name) => delivery.properties[name] !== undefined)
          .map((name) => [name, delivery.properties[name]]),
      ),
    }),
    delivery,
    ...images,
  };
}
