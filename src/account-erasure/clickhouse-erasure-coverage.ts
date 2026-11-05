import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import { classifyClickHouseManagedTableEngine } from "./clickhouse-physical-erasure.ts";

interface AccountErasureClickHouseQueryClient {
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<unknown> }>;
}
const identifierSchema = z.uuid();
export const PRODUCTION_MANAGED_DATABASES = ["analytics", "ingest", "postgres_fitness"] as const;

const DBT_STAGING_MARKER = "__dbt_new_data_";

export const identifierNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const physicalTableSchema = z.object({
  age_milliseconds: z.coerce.number().int().nonnegative(),
  columns: z.array(z.tuple([identifierNameSchema, z.string().min(1)])),
  database: identifierNameSchema,
  engine: z.string().min(1),
  name: identifierNameSchema,
  uuid: z.uuid(),
});

export type PhysicalTable = z.infer<typeof physicalTableSchema>;

export type UuidIdentifierFamily = "activityIds" | "operationIds" | "sleepIds";

export interface IdentifierColumnDefinition {
  cardinality: "array" | "scalar";
  family: UuidIdentifierFamily | "stringRelationIds";
  valueType: "string" | "uuid";
}

const identifierColumnDefinitions: Readonly<Record<string, readonly IdentifierColumnDefinition[]>> =
  {
    activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    canonical_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    connected_activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    duplicate_activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    group_id: [
      { cardinality: "scalar", family: "activityIds", valueType: "uuid" },
      { cardinality: "scalar", family: "stringRelationIds", valueType: "string" },
    ],
    linked_activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    member_activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    member_activity_ids: [{ cardinality: "array", family: "activityIds", valueType: "uuid" }],
    operation_id: [{ cardinality: "scalar", family: "operationIds", valueType: "uuid" }],
    primary_activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
    representative_activity_id: [
      { cardinality: "scalar", family: "activityIds", valueType: "uuid" },
    ],
    origin_candidate_member_ids: [
      { cardinality: "array", family: "activityIds", valueType: "uuid" },
    ],
    selected_session_id: [{ cardinality: "scalar", family: "sleepIds", valueType: "uuid" }],
    session_id: [{ cardinality: "scalar", family: "sleepIds", valueType: "uuid" }],
    sleep_id: [{ cardinality: "scalar", family: "sleepIds", valueType: "uuid" }],
    sleep_session_id: [{ cardinality: "scalar", family: "sleepIds", valueType: "uuid" }],
    source_activity_id: [{ cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
  };

const recordReferenceColumns = new Set([
  "measurement_id",
  "metric_stream_id",
  "panel_id",
  "source_metric_stream_id",
]);

const peerDbColumns = {
  _peerdb_synced_at: "DateTime64(9)",
  _peerdb_is_deleted: "Int8",
  _peerdb_version: "Int64",
};

const deliveryColumns = {
  epoch: "String",
  topic: "String",
  partition: "Int32",
  transport: "Enum8('pulsar'=1,'kafka'=2)",
  kafka_offset: "UInt64",
  major: "UInt64",
  minor: "UInt64",
  batch: "Int32",
};

const sharedSystemColumns: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "analytics.schema_migrations": { id: "String", applied_at: "DateTime" },
  "analytics.sleep_heart_rate_cutover": { cutover_at: "DateTime64(9, 'UTC')" },
  "analytics.delivery_receipt": {
    ...deliveryColumns,
    preparation_attempt: "UUID",
    serialized_message_id: "String",
    effect_count: "UInt64",
    chunk_count: "UInt64",
    effect_digest: "FixedString(64)",
    stages: "Array(String)",
    status: "Enum8('prepared'=1,'committed'=2)",
  },
  [ACCOUNT_ERASURE_FENCE_TABLE]: { user_hash: "FixedString(64)", erased_at: "DateTime64(9)" },
  [ACCOUNT_ERASURE_OPERATION_FENCE_TABLE]: {
    operation_hash: "FixedString(64)",
    erased_at: "DateTime64(9)",
  },
  "postgres_fitness.provider_priority": {
    provider_id: "String",
    priority: "Int32",
    sleep_priority: "Nullable(Int32)",
    body_priority: "Nullable(Int32)",
    recovery_priority: "Nullable(Int32)",
    daily_activity_priority: "Nullable(Int32)",
    ...peerDbColumns,
  },
  "postgres_fitness.provider_field_priority": {
    provider_id: "String",
    field_key: "String",
    priority: "Int64",
    ...peerDbColumns,
  },
  "postgres_fitness.device_priority": {
    provider_id: "String",
    source_name_pattern: "String",
    priority: "Nullable(Int32)",
    sleep_priority: "Nullable(Int32)",
    body_priority: "Nullable(Int32)",
    recovery_priority: "Nullable(Int32)",
    daily_activity_priority: "Nullable(Int32)",
    ...peerDbColumns,
  },
  "postgres_fitness.sensor_provider_priority": {
    provider_id: "String",
    channel: "String",
    priority: "Int32",
    ...peerDbColumns,
  },
  "postgres_fitness.sensor_device_priority": {
    provider_id: "String",
    source_name_pattern: "String",
    channel: "String",
    priority: "Int32",
    ...peerDbColumns,
  },
};

function assertColumnContract(
  table: PhysicalTable,
  expected: Readonly<Record<string, string>>,
): void {
  const actual = columnTypes(table);
  const names = new Set([...actual.keys(), ...Object.keys(expected)]);
  for (const name of names) {
    const actualType = actual.get(name)?.replaceAll(/\s+/g, "");
    const expectedType = expected[name]?.replaceAll(/\s+/g, "");
    if (actualType !== expectedType) {
      throw new Error(
        `Unhandled ClickHouse account-erasure schema drift: ${tableKey(table)}.${name} violates its column contract`,
      );
    }
  }
}

function sharedSystemContract(table: PhysicalTable): Readonly<Record<string, string>> | undefined {
  return sharedSystemColumns[`${table.database}.${baseTableName(table)}`];
}

const harmlessIdentifierColumns = new Set([
  "absent_source_external_ids",
  "batch_id",
  "preparation_attempt",
  "device_id",
  "event_id",
  "external_id",
  "id",
  "provider_food_id",
  "provider_id",
  "provider_serving_id",
  "source_external_ids",
]);

const strongPersonalDataColumns = new Set([
  "address",
  "birth_date",
  "email",
  "lat",
  "latitude",
  "lng",
  "longitude",
  "metadata",
  "notes",
  "phone",
  "point",
  "raw",
]);

const probableOwnershipIdentifierPattern =
  /(?:^|_)(?:account|activity|group|measurement|metric_stream|operation|owner|panel|person|processing|profile|session|sleep|user)(?:_[a-z0-9]+)*_ids?$/;

export function qualifiedTable(database: string, table: string): string {
  return `\`${database}\`.\`${table}\``;
}

function tableKey(table: Pick<PhysicalTable, "database" | "name">): string {
  return `${table.database}.${table.name}`;
}

function dbtStagingCanonicalName(tableName: string): string | null {
  const markerIndex = tableName.lastIndexOf(DBT_STAGING_MARKER);
  if (markerIndex <= 0) return null;
  const invocationId = tableName
    .slice(markerIndex + DBT_STAGING_MARKER.length)
    .replaceAll("_", "-");
  if (!identifierSchema.safeParse(invocationId).success) return null;
  return tableName.slice(0, markerIndex);
}

export function baseTableName(table: PhysicalTable): string {
  return dbtStagingCanonicalName(table.name) ?? table.name;
}

export function columnTypes(table: PhysicalTable): Map<string, string> {
  return new Map(table.columns);
}

export function hasUuidScalarColumn(table: PhysicalTable, columnName: string): boolean {
  const type = columnTypes(table).get(columnName);
  return type === "UUID" || type === "Nullable(UUID)";
}

function isProtectedFenceTable(table: PhysicalTable): boolean {
  return (
    tableKey(table) === ACCOUNT_ERASURE_FENCE_TABLE ||
    tableKey(table) === ACCOUNT_ERASURE_OPERATION_FENCE_TABLE
  );
}

export function isUserProfileTable(table: PhysicalTable): boolean {
  return baseTableName(table) === "user_profile";
}

export function identifierColumns(
  table: PhysicalTable,
): Array<[string, IdentifierColumnDefinition]> {
  const definitions: Array<[string, IdentifierColumnDefinition]> = [];
  for (const [columnName, actualType] of table.columns) {
    const definition = resolveIdentifierColumnDefinition(table, columnName, actualType);
    if (definition) {
      definitions.push([columnName, definition]);
    }
  }
  return definitions;
}

function isPersonalDataTable(table: PhysicalTable): boolean {
  return (
    hasUuidScalarColumn(table, "user_id") ||
    (isUserProfileTable(table) && hasUuidScalarColumn(table, "id")) ||
    identifierColumns(table).length > 0
  );
}

function matchesIdentifierColumnType(
  definition: IdentifierColumnDefinition,
  actualType: string,
): boolean {
  const expectedTypes =
    definition.valueType === "uuid"
      ? definition.cardinality === "array"
        ? new Set(["Array(UUID)", "Array(Nullable(UUID))"])
        : new Set(["UUID", "Nullable(UUID)"])
      : definition.cardinality === "array"
        ? new Set(["Array(String)", "Array(Nullable(String))"])
        : new Set(["String", "Nullable(String)", "LowCardinality(String)"]);
  return expectedTypes.has(actualType);
}

function resolveIdentifierColumnDefinition(
  table: PhysicalTable,
  columnName: string,
  actualType: string,
): IdentifierColumnDefinition | undefined {
  const alternatives = identifierColumnDefinitions[columnName];
  if (!alternatives) return undefined;
  const definition = alternatives.find((candidate) =>
    matchesIdentifierColumnType(candidate, actualType),
  );
  if (!definition) {
    throw new Error(
      `Unhandled ClickHouse account-erasure schema drift: ${tableKey(table)}.${columnName} has type ${actualType}`,
    );
  }
  return definition;
}

function validatePhysicalTableSchema(table: PhysicalTable): void {
  const types = columnTypes(table);
  const userIdType = types.get("user_id");
  if (userIdType !== undefined && userIdType !== "UUID" && userIdType !== "Nullable(UUID)") {
    throw new Error(
      `Unhandled ClickHouse account-erasure schema drift: ${tableKey(table)}.user_id has type ${userIdType}`,
    );
  }
  for (const [columnName, actualType] of table.columns) {
    const definition = resolveIdentifierColumnDefinition(table, columnName, actualType);
    if (definition || recordReferenceColumns.has(columnName)) {
      continue;
    }
    if (
      columnName !== "user_id" &&
      !harmlessIdentifierColumns.has(columnName) &&
      probableOwnershipIdentifierPattern.test(columnName)
    ) {
      throw new Error(
        `Unhandled ClickHouse account-erasure schema drift: ${tableKey(table)}.${columnName} is not mapped to an ownership relation`,
      );
    }
  }
  const hasStrongPersonalData = table.columns.some(([columnName]) =>
    strongPersonalDataColumns.has(columnName),
  );
  if (hasStrongPersonalData && !isPersonalDataTable(table)) {
    throw new Error(
      `Unhandled ClickHouse personal-data table without an ownership relation: ${tableKey(table)}`,
    );
  }
}

export function isStructuralEffectReceiptTable(table: Pick<PhysicalTable, "name">): boolean {
  return table.name === "effect_receipt";
}

function validateOwnershipDomain(table: PhysicalTable): void {
  const shared = sharedSystemContract(table);
  if (shared) {
    assertColumnContract(table, shared);
    return;
  }
  const canonicalName = baseTableName(table);
  if (table.database === "postgres_fitness" && canonicalName === "provider") {
    assertColumnContract(table, {
      id: "String",
      name: "String",
      api_base_url: "Nullable(String)",
      user_id: "Nullable(UUID)",
      created_at: "DateTime64(6, 'UTC')",
      ...peerDbColumns,
    });
    return;
  }
  if (isStructuralEffectReceiptTable(table)) {
    assertColumnContract(table, {
      ...deliveryColumns,
      preparation_attempt: "UUID",
      effect_ordinal: "Int128",
      stage: "Enum8('scalar'=1,'dedup'=2,'activity'=3)",
      effect_hash: "FixedString(64)",
      is_empty: "UInt8",
      user_id: "Nullable(UUID)",
      outcome: "Enum8('written'=1,'fenced'=2,'generation_filtered'=3)",
    });
    return;
  }
  if (table.database === "ingest" && canonicalName === "metric_stream_delete_acknowledgement") {
    assertColumnContract(table, {
      event_id: "UUID",
      applied_at: "DateTime64(9)",
    });
    return;
  }
  validatePhysicalTableSchema(table);
  const types = columnTypes(table);
  const directOwner = types.get("user_id") === "UUID";
  const relations = identifierColumns(table);
  const domainReferences = table.columns.filter(([name]) => recordReferenceColumns.has(name));
  for (const [name, type] of domainReferences) {
    if (!directOwner || (type !== "UUID" && type !== "Nullable(UUID)")) {
      throw new Error(
        `Unsupported ClickHouse record ownership relation: ${tableKey(table)}.${name} (${type})`,
      );
    }
  }
  if (directOwner || (isUserProfileTable(table) && types.get("id") === "UUID")) return;

  if (hasUuidScalarColumn(table, "id")) {
    const parentColumn =
      canonicalName === "sleep_stage"
        ? "session_id"
        : [
              "processing_flow_marker",
              "processing_flow_marker_provider_inventory",
              "processing_flow_marker_sensor_priority",
            ].includes(canonicalName)
          ? "operation_id"
          : null;
    if (!parentColumn || types.get("id") !== "UUID" || types.get(parentColumn) !== "UUID") {
      throw new Error(
        `Unclassified ClickHouse UUID identity ownership domain: ${tableKey(table)}.id`,
      );
    }
  }
  if (relations.length > 0) return;

  throw new Error(`Unclassified ClickHouse physical ownership domain: ${tableKey(table)}`);
}

async function listManagedTables(
  client: AccountErasureClickHouseQueryClient,
  managedDatabases: readonly string[],
): Promise<PhysicalTable[]> {
  // Bound catalog payload before groupArray materializes column metadata.
  const budget = await client.query({
    query: `SELECT count() AS tables,(SELECT coalesce(sum(6*(length(name)+length(type))+256),0)
      FROM system.columns WHERE database IN {managed_databases:Array(String)}) AS bytes
      FROM system.tables WHERE database IN {managed_databases:Array(String)}`,
    query_params: { managed_databases: managedDatabases },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const [size] = z
    .tuple([z.object({ tables: z.coerce.number(), bytes: z.coerce.number() })])
    .parse(await budget.json());
  if (size.tables > 500 || size.bytes > 1024 * 1024)
    throw new Error(
      "ClickHouse account erasure catalog exceeds its 500-table/1 MiB metadata budget; contact support before retrying",
    );
  const result = await client.query({
    query: `SELECT
        tables.database AS database,
        tables.name AS name,
        tables.engine AS engine,
        toString(tables.uuid) AS uuid,
        greatest(
          dateDiff(
            'millisecond',
            tables.metadata_modification_time,
            now64(3)
          ),
          0
        ) AS age_milliseconds,
        groupArray((columns.name, columns.type)) AS columns
      FROM system.tables AS tables
      INNER JOIN system.columns AS columns
        ON columns.database = tables.database
        AND columns.table = tables.name
      WHERE tables.database IN {managed_databases:Array(String)}
      GROUP BY
        tables.database,
        tables.name,
        tables.engine,
        tables.uuid,
        tables.metadata_modification_time
      ORDER BY tables.database, tables.name`,
    query_params: { managed_databases: managedDatabases },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return z.array(physicalTableSchema).parse(await result.json());
}

export function clickHouseErasureSchemaDigest(tables: readonly PhysicalTable[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        tables
          .map((table) => [
            table.database,
            table.name,
            table.uuid,
            table.engine,
            [...table.columns].sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          ])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ),
    )
    .digest("hex");
}

function assertMatchingStagingSchema(
  stagingTable: PhysicalTable,
  canonicalTable: PhysicalTable,
): void {
  const stagingTypes = columnTypes(stagingTable);
  const canonicalTypes = columnTypes(canonicalTable);
  const stagingOwnershipColumns = new Set([
    ...identifierColumns(stagingTable).map(([columnName]) => columnName),
    ...stagingTable.columns
      .filter(([name]) => name === "id" || recordReferenceColumns.has(name))
      .map(([name]) => name),
    ...(hasUuidScalarColumn(stagingTable, "user_id") ? ["user_id"] : []),
    ...(isUserProfileTable(stagingTable) && hasUuidScalarColumn(stagingTable, "id") ? ["id"] : []),
  ]);
  const canonicalOwnershipColumns = new Set([
    ...identifierColumns(canonicalTable).map(([columnName]) => columnName),
    ...canonicalTable.columns
      .filter(([name]) => name === "id" || recordReferenceColumns.has(name))
      .map(([name]) => name),
    ...(hasUuidScalarColumn(canonicalTable, "user_id") ? ["user_id"] : []),
    ...(isUserProfileTable(canonicalTable) && hasUuidScalarColumn(canonicalTable, "id")
      ? ["id"]
      : []),
  ]);
  const ownershipColumns = new Set([...stagingOwnershipColumns, ...canonicalOwnershipColumns]);
  for (const columnName of ownershipColumns) {
    if (
      !stagingOwnershipColumns.has(columnName) ||
      !canonicalOwnershipColumns.has(columnName) ||
      canonicalTypes.get(columnName) !== stagingTypes.get(columnName)
    ) {
      throw new Error(
        `Unsafe ClickHouse dbt staging schema mismatch: ${tableKey(stagingTable)}.${columnName}`,
      );
    }
  }
}

function isKnownNonPersonalUnsupportedTable(table: PhysicalTable): boolean {
  return (
    table.database === "analytics" &&
    table.name === "sleep_heart_rate_cutover" &&
    table.engine === "TinyLog" &&
    table.columns.length === 1 &&
    table.columns[0]?.[0] === "cutover_at" &&
    table.columns[0]?.[1] === "DateTime64(9, 'UTC')"
  );
}

/** Inspect ownership at startup and erasure; mutation-stage activity is checked by the eraser. */
export async function inspectClickHouseAccountErasureCoverage(
  client: AccountErasureClickHouseQueryClient,
  options: { managedDatabases?: readonly string[] } = {},
): Promise<PhysicalTable[]> {
  const managedDatabases = z
    .array(identifierNameSchema)
    .min(1)
    .parse(options.managedDatabases ?? PRODUCTION_MANAGED_DATABASES);
  const allTables = await listManagedTables(client, managedDatabases);
  const physicalTables: PhysicalTable[] = [];
  for (const table of allTables) {
    const engineKind = classifyClickHouseManagedTableEngine(table.engine);
    if (engineKind === "non-storage") continue;
    if (engineKind === "unsupported-storage") {
      if (isKnownNonPersonalUnsupportedTable(table)) {
        validateOwnershipDomain(table);
        continue;
      }
      throw new Error(
        `Unsupported ClickHouse physical storage engine for ${tableKey(table)}: ${table.engine}`,
      );
    }
    physicalTables.push(table);
  }
  const tablesByKey = new Map(physicalTables.map((table) => [tableKey(table), table]));
  const personalTables: PhysicalTable[] = [];
  for (const table of physicalTables) {
    const canonicalName = dbtStagingCanonicalName(table.name);
    if (table.name.includes(DBT_STAGING_MARKER) && !canonicalName) {
      throw new Error(`Unsafe ClickHouse dbt staging table name: ${tableKey(table)}`);
    }
    if (canonicalName) {
      const canonicalTable = tablesByKey.get(`${table.database}.${canonicalName}`);
      if (!canonicalTable) {
        throw new Error(
          `Unsafe orphan ClickHouse dbt staging table without a canonical match: ${tableKey(table)}`,
        );
      }
      assertMatchingStagingSchema(table, canonicalTable);
    }
    validateOwnershipDomain(table);
    if (!isProtectedFenceTable(table) && isPersonalDataTable(table)) {
      if (table.uuid === "00000000-0000-0000-0000-000000000000")
        throw new Error(
          `ClickHouse erasure target has no physical UUID binding: ${tableKey(table)}`,
        );
      personalTables.push(table);
    }
  }
  return personalTables;
}
