import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import { markMetricStreamScopeDeletedInClickHouse } from "../metric-stream/clickhouse-sink.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import {
  applyClickHousePhysicalErasureMutation,
  classifyClickHouseManagedTableEngine,
  prepareClickHousePhysicalErasure,
  waitForClickHousePhysicalErasure,
} from "./clickhouse-physical-erasure.ts";

const PRODUCTION_MANAGED_DATABASES = ["analytics", "ingest", "postgres_fitness"] as const;
const DBT_STAGING_MARKER = "__dbt_new_data_";
const DEFAULT_IDENTIFIER_EXPANSION_MAXIMUM_PASSES = 256;
const DEFAULT_ORPHAN_STAGING_MINIMUM_AGE_MILLISECONDS = 15 * 60 * 1_000;
const DEFAULT_PHYSICAL_PART_POLL_INTERVAL_MILLISECONDS = 1_000;
const DEFAULT_PHYSICAL_PART_WAIT_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;

const identifierSchema = z.string().uuid();
const accountErasureIdentifiersSchema = z.object({
  activityIds: z.array(identifierSchema),
  operationIds: z.array(identifierSchema),
  sleepSessionIds: z.array(identifierSchema),
  userId: identifierSchema,
});
const identifierNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const physicalTableSchema = z.object({
  age_milliseconds: z.coerce.number().int().nonnegative(),
  columns: z.array(z.tuple([identifierNameSchema, z.string().min(1)])),
  database: identifierNameSchema,
  engine: z.string().min(1),
  name: identifierNameSchema,
});
const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
const capturedIdentifiersSchema = z.tuple([
  z.object({
    activity_ids: z.array(identifierSchema),
    operation_ids: z.array(identifierSchema),
    record_ids: z.array(identifierSchema),
    sleep_ids: z.array(identifierSchema),
    string_relation_ids: z.array(z.string().min(1)),
  }),
]);
const resolvedOptionsSchema = z.object({
  identifierExpansionMaximumPasses: z.number().int().positive(),
  managedDatabases: z.array(identifierNameSchema).min(1),
  orphanStagingMinimumAgeMilliseconds: z.number().int().nonnegative(),
  physicalPartPollIntervalMilliseconds: z.number().int().positive(),
  physicalPartWaitTimeoutMilliseconds: z.number().int().positive(),
});

interface AccountErasureClickHouseClient {
  command: ClickHouseCommandClient["command"];
  insert?: NonNullable<ClickHouseCommandClient["insert"]>;
  query(options: {
    query: string;
    query_id?: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface ClickHouseAccountErasureIdentifiers {
  activityIds: readonly string[];
  operationIds: readonly string[];
  sleepSessionIds: readonly string[];
  userId: string;
}

export interface ClickHouseAccountErasureOptions {
  identifierExpansionMaximumPasses?: number;
  managedDatabases?: readonly string[];
  orphanStagingMinimumAgeMilliseconds?: number;
  physicalPartPollIntervalMilliseconds?: number;
  physicalPartWaitTimeoutMilliseconds?: number;
}

type PhysicalTable = z.infer<typeof physicalTableSchema>;
type ResolvedOptions = z.infer<typeof resolvedOptionsSchema>;
type UuidIdentifierFamily = "activityIds" | "operationIds" | "recordIds" | "sleepIds";

interface IdentifierColumnDefinition {
  cardinality: "array" | "scalar";
  family: UuidIdentifierFamily | "stringRelationIds";
  valueType: "string" | "uuid";
}

interface IdentifierState {
  activityIds: Set<string>;
  operationIds: Set<string>;
  recordIds: Set<string>;
  sleepIds: Set<string>;
  stringRelationIds: Set<string>;
  userId: string;
}

interface PersonalDataPredicate {
  mutationQueryParameters: Record<string, unknown>;
  mutationSql: string;
  queryParameters: Record<string, unknown>;
  sql: string;
}

const identifierColumnDefinitions: Readonly<Record<string, IdentifierColumnDefinition>> = {
  activity_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  canonical_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  connected_activity_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  duplicate_activity_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  group_id: {
    cardinality: "scalar",
    family: "stringRelationIds",
    valueType: "string",
  },
  linked_activity_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  measurement_id: {
    cardinality: "scalar",
    family: "recordIds",
    valueType: "uuid",
  },
  member_activity_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  member_activity_ids: {
    cardinality: "array",
    family: "activityIds",
    valueType: "uuid",
  },
  metric_stream_id: {
    cardinality: "scalar",
    family: "recordIds",
    valueType: "uuid",
  },
  operation_id: {
    cardinality: "scalar",
    family: "operationIds",
    valueType: "uuid",
  },
  panel_id: {
    cardinality: "scalar",
    family: "recordIds",
    valueType: "uuid",
  },
  primary_activity_id: {
    cardinality: "scalar",
    family: "activityIds",
    valueType: "uuid",
  },
  session_id: {
    cardinality: "scalar",
    family: "sleepIds",
    valueType: "uuid",
  },
  sleep_id: {
    cardinality: "scalar",
    family: "sleepIds",
    valueType: "uuid",
  },
  sleep_session_id: {
    cardinality: "scalar",
    family: "sleepIds",
    valueType: "uuid",
  },
  source_metric_stream_id: {
    cardinality: "scalar",
    family: "recordIds",
    valueType: "uuid",
  },
};

const harmlessIdentifierColumns = new Set([
  "absent_source_external_ids",
  "batch_id",
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

function resolveOptions(options: ClickHouseAccountErasureOptions): ResolvedOptions {
  return resolvedOptionsSchema.parse({
    identifierExpansionMaximumPasses:
      options.identifierExpansionMaximumPasses ?? DEFAULT_IDENTIFIER_EXPANSION_MAXIMUM_PASSES,
    managedDatabases: [...new Set(options.managedDatabases ?? PRODUCTION_MANAGED_DATABASES)],
    orphanStagingMinimumAgeMilliseconds:
      options.orphanStagingMinimumAgeMilliseconds ??
      DEFAULT_ORPHAN_STAGING_MINIMUM_AGE_MILLISECONDS,
    physicalPartPollIntervalMilliseconds:
      options.physicalPartPollIntervalMilliseconds ??
      DEFAULT_PHYSICAL_PART_POLL_INTERVAL_MILLISECONDS,
    physicalPartWaitTimeoutMilliseconds:
      options.physicalPartWaitTimeoutMilliseconds ??
      DEFAULT_PHYSICAL_PART_WAIT_TIMEOUT_MILLISECONDS,
  });
}

function qualifiedTable(database: string, table: string): string {
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

function baseTableName(table: PhysicalTable): string {
  return dbtStagingCanonicalName(table.name) ?? table.name;
}

function columnTypes(table: PhysicalTable): Map<string, string> {
  return new Map(table.columns);
}

function hasUuidScalarColumn(table: PhysicalTable, columnName: string): boolean {
  const type = columnTypes(table).get(columnName);
  return type === "UUID" || type === "Nullable(UUID)";
}

function isProtectedFenceTable(table: PhysicalTable): boolean {
  return (
    tableKey(table) === ACCOUNT_ERASURE_FENCE_TABLE ||
    tableKey(table) === ACCOUNT_ERASURE_OPERATION_FENCE_TABLE
  );
}

function isUserProfileTable(table: PhysicalTable): boolean {
  return baseTableName(table) === "user_profile";
}

function identifierColumns(table: PhysicalTable): Array<[string, IdentifierColumnDefinition]> {
  const definitions: Array<[string, IdentifierColumnDefinition]> = [];
  for (const [columnName] of table.columns) {
    const definition = identifierColumnDefinitions[columnName];
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

function validateIdentifierColumnType(
  table: PhysicalTable,
  columnName: string,
  definition: IdentifierColumnDefinition,
  actualType: string,
): void {
  const expectedTypes =
    definition.valueType === "uuid"
      ? definition.cardinality === "array"
        ? new Set(["Array(UUID)", "Array(Nullable(UUID))"])
        : new Set(["UUID", "Nullable(UUID)"])
      : definition.cardinality === "array"
        ? new Set(["Array(String)", "Array(Nullable(String))"])
        : new Set(["String", "Nullable(String)", "LowCardinality(String)"]);
  if (!expectedTypes.has(actualType)) {
    throw new Error(
      `Unhandled ClickHouse account-erasure schema drift: ${tableKey(table)}.${columnName} has type ${actualType}`,
    );
  }
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
    const definition = identifierColumnDefinitions[columnName];
    if (definition) {
      validateIdentifierColumnType(table, columnName, definition, actualType);
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

async function listManagedTables(
  client: AccountErasureClickHouseClient,
  managedDatabases: readonly string[],
): Promise<PhysicalTable[]> {
  const result = await client.query({
    query: `SELECT
        tables.database AS database,
        tables.name AS name,
        tables.engine AS engine,
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
        tables.metadata_modification_time
      ORDER BY tables.database, tables.name`,
    query_params: { managed_databases: managedDatabases },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return z.array(physicalTableSchema).parse(await result.json());
}

function assertMatchingStagingSchema(
  stagingTable: PhysicalTable,
  canonicalTable: PhysicalTable,
): void {
  const stagingTypes = columnTypes(stagingTable);
  const canonicalTypes = columnTypes(canonicalTable);
  const stagingOwnershipColumns = new Set([
    ...identifierColumns(stagingTable).map(([columnName]) => columnName),
    ...(hasUuidScalarColumn(stagingTable, "user_id") ? ["user_id"] : []),
    ...(isUserProfileTable(stagingTable) && hasUuidScalarColumn(stagingTable, "id") ? ["id"] : []),
  ]);
  const canonicalOwnershipColumns = new Set([
    ...identifierColumns(canonicalTable).map(([columnName]) => columnName),
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

async function hasActiveTableQuery(
  client: AccountErasureClickHouseClient,
  table: PhysicalTable,
): Promise<boolean> {
  const plainName = `${table.database}.${table.name}`;
  const quotedName = qualifiedTable(table.database, table.name);
  const result = await client.query({
    query: `SELECT count() AS count
      FROM system.processes
      WHERE query_id != currentQueryID()
        AND (
          positionCaseInsensitive(query, {plain_name:String}) > 0
          OR positionCaseInsensitive(query, {quoted_name:String}) > 0
        )`,
    query_params: {
      plain_name: plainName,
      quoted_name: quotedName,
    },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const [row] = countRowsSchema.parse(await result.json());
  return row.count > 0;
}

async function validateAndSelectPersonalTables(
  client: AccountErasureClickHouseClient,
  allTables: readonly PhysicalTable[],
  options: ResolvedOptions,
): Promise<PhysicalTable[]> {
  const physicalTables: PhysicalTable[] = [];
  for (const table of allTables) {
    const engineKind = classifyClickHouseManagedTableEngine(table.engine);
    if (engineKind === "non-storage") {
      continue;
    }
    if (engineKind === "unsupported-storage") {
      if (isKnownNonPersonalUnsupportedTable(table)) {
        continue;
      }
      throw new Error(
        `Unsupported ClickHouse physical storage engine for ${tableKey(table)}: ${table.engine}`,
      );
    }
    physicalTables.push(table);
    if (!isProtectedFenceTable(table)) {
      validatePhysicalTableSchema(table);
    }
  }
  const tablesByKey = new Map(physicalTables.map((table) => [tableKey(table), table]));
  const personalTables: PhysicalTable[] = [];
  for (const table of physicalTables) {
    if (isProtectedFenceTable(table)) {
      continue;
    }
    const canonicalName = dbtStagingCanonicalName(table.name);
    if (table.name.includes(DBT_STAGING_MARKER) && !canonicalName) {
      throw new Error(`Unsafe ClickHouse dbt staging table name: ${tableKey(table)}`);
    }
    if (!isPersonalDataTable(table)) {
      continue;
    }
    if (canonicalName) {
      const canonicalTable = tablesByKey.get(`${table.database}.${canonicalName}`);
      if (!canonicalTable) {
        throw new Error(
          `Unsafe orphan ClickHouse dbt staging table without a canonical match: ${tableKey(table)}`,
        );
      }
      assertMatchingStagingSchema(table, canonicalTable);
      if (
        table.age_milliseconds < options.orphanStagingMinimumAgeMilliseconds ||
        (await hasActiveTableQuery(client, table))
      ) {
        throw new Error(`Cannot erase an active dbt staging table: ${tableKey(table)}`);
      }
    }
    personalTables.push(table);
  }
  return personalTables;
}

function setQueryParameter(
  queryParameters: Record<string, unknown>,
  parameterName: string,
  identifiers: Set<string>,
): void {
  queryParameters[parameterName] = [...identifiers];
}

function hashIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}

function setHashQueryParameter(
  queryParameters: Record<string, unknown>,
  parameterName: string,
  identifiers: Set<string>,
): void {
  queryParameters[parameterName] = [...identifiers].map(hashIdentifier);
}

function hashedColumnExpression(columnExpression: string): string {
  return `lower(hex(SHA256(toString(${columnExpression}))))`;
}

function relationPredicate(
  columnName: string,
  definition: IdentifierColumnDefinition,
  state: IdentifierState,
  queryParameters: Record<string, unknown>,
  mutationQueryParameters: Record<string, unknown>,
): { mutationSql: string; sql: string } | null {
  const values = state[definition.family];
  if (values.size === 0) return null;
  const parameterName =
    definition.family === "stringRelationIds"
      ? "string_relation_ids"
      : definition.family === "activityIds"
        ? "activity_ids"
        : definition.family === "operationIds"
          ? "operation_ids"
          : definition.family === "recordIds"
            ? "record_ids"
            : "sleep_ids";
  setQueryParameter(queryParameters, parameterName, values);
  const mutationParameterName = `${parameterName}_hashes`;
  setHashQueryParameter(mutationQueryParameters, mutationParameterName, values);
  const parameterType = definition.valueType === "string" ? "Array(String)" : "Array(UUID)";
  const sql =
    definition.cardinality === "array"
      ? `hasAny(\`${columnName}\`, {${parameterName}:${parameterType}})`
      : `\`${columnName}\` IN {${parameterName}:${parameterType}}`;
  const hashedColumn =
    definition.cardinality === "array"
      ? `arrayMap(identifier_value -> ${hashedColumnExpression("identifier_value")}, \`${columnName}\`)`
      : hashedColumnExpression(`\`${columnName}\``);
  const mutationSql =
    definition.cardinality === "array"
      ? `hasAny(${hashedColumn}, {${mutationParameterName}:Array(String)})`
      : `${hashedColumn} IN {${mutationParameterName}:Array(String)}`;
  return { mutationSql, sql };
}

function tableIdentityFamilies(table: PhysicalTable): UuidIdentifierFamily[] {
  if (!hasUuidScalarColumn(table, "id") || isUserProfileTable(table)) {
    return [];
  }
  const families: UuidIdentifierFamily[] = ["recordIds"];
  const canonicalName = baseTableName(table);
  if (canonicalName === "activity") {
    families.push("activityIds");
  }
  if (canonicalName === "sleep_session") {
    families.push("sleepIds");
  }
  return families;
}

function personalDataPredicate(
  table: PhysicalTable,
  state: IdentifierState,
): PersonalDataPredicate | null {
  const queryParameters: Record<string, unknown> = {};
  const mutationQueryParameters: Record<string, unknown> = {};
  const relationshipPredicates = identifierColumns(table)
    .map(([columnName, definition]) =>
      relationPredicate(columnName, definition, state, queryParameters, mutationQueryParameters),
    )
    .filter((predicate): predicate is { mutationSql: string; sql: string } => predicate !== null);
  for (const family of tableIdentityFamilies(table)) {
    const values = state[family];
    if (values.size === 0) continue;
    const parameterName =
      family === "activityIds"
        ? "activity_ids"
        : family === "sleepIds"
          ? "sleep_ids"
          : "record_ids";
    setQueryParameter(queryParameters, parameterName, values);
    const mutationParameterName = `${parameterName}_hashes`;
    setHashQueryParameter(mutationQueryParameters, mutationParameterName, values);
    relationshipPredicates.push({
      mutationSql: `${hashedColumnExpression("id")} IN {${mutationParameterName}:Array(String)}`,
      sql: `id IN {${parameterName}:Array(UUID)}`,
    });
  }
  if (hasUuidScalarColumn(table, "user_id")) {
    queryParameters.user_id = state.userId;
    mutationQueryParameters.user_hash = hashIdentifier(state.userId);
    const userPredicate = "user_id = {user_id:UUID}";
    const mutationUserPredicate = `${hashedColumnExpression("user_id")} = {user_hash:String}`;
    const userIdType = columnTypes(table).get("user_id");
    if (userIdType === "Nullable(UUID)" && relationshipPredicates.length > 0) {
      return {
        mutationQueryParameters,
        mutationSql: `(${mutationUserPredicate}) OR (user_id IS NULL AND (${relationshipPredicates
          .map((predicate) => predicate.mutationSql)
          .join(" OR ")}))`,
        queryParameters,
        sql: `(${userPredicate}) OR (user_id IS NULL AND (${relationshipPredicates
          .map((predicate) => predicate.sql)
          .join(" OR ")}))`,
      };
    }
    return {
      mutationQueryParameters,
      mutationSql: mutationUserPredicate,
      queryParameters,
      sql: userPredicate,
    };
  }
  if (isUserProfileTable(table) && hasUuidScalarColumn(table, "id")) {
    queryParameters.user_id = state.userId;
    mutationQueryParameters.user_hash = hashIdentifier(state.userId);
    return {
      mutationQueryParameters,
      mutationSql: `${hashedColumnExpression("id")} = {user_hash:String}`,
      queryParameters,
      sql: "id = {user_id:UUID}",
    };
  }
  if (relationshipPredicates.length === 0) return null;
  return {
    mutationQueryParameters,
    mutationSql: relationshipPredicates
      .map((predicate) => `(${predicate.mutationSql})`)
      .join(" OR "),
    queryParameters,
    sql: relationshipPredicates.map((predicate) => `(${predicate.sql})`).join(" OR "),
  };
}

function identifierArrayExpression(
  table: PhysicalTable,
  family: UuidIdentifierFamily | "stringRelationIds",
): string {
  const scalarExpressions: string[] = [];
  const arrayExpressions: string[] = [];
  for (const [columnName, definition] of identifierColumns(table)) {
    if (definition.family !== family) continue;
    if (definition.cardinality === "array") {
      arrayExpressions.push(
        `arrayMap(identifier_value -> toString(identifier_value), \`${columnName}\`)`,
      );
    } else {
      scalarExpressions.push(`ifNull(toString(\`${columnName}\`), '')`);
    }
  }
  if (family !== "stringRelationIds") {
    for (const identityFamily of tableIdentityFamilies(table)) {
      if (identityFamily === family) {
        scalarExpressions.push("ifNull(toString(id), '')");
      }
    }
  }
  const rowArrays: string[] = [];
  if (scalarExpressions.length > 0) {
    rowArrays.push(`[${scalarExpressions.join(", ")}]`);
  }
  rowArrays.push(...arrayExpressions);
  if (rowArrays.length === 0) {
    return "arrayFlatten(groupArray(CAST([], 'Array(String)')))";
  }
  return `arrayDistinct(
    arrayFilter(
      identifier_value -> identifier_value != '',
      arrayFlatten(groupArray(arrayConcat(${rowArrays.join(", ")})))
    )
  )`;
}

async function captureIdentifiersFromTable(
  client: AccountErasureClickHouseClient,
  table: PhysicalTable,
  state: IdentifierState,
): Promise<z.infer<typeof capturedIdentifiersSchema>[number] | null> {
  const predicate = personalDataPredicate(table, state);
  if (!predicate) return null;
  const result = await client.query({
    query: `SELECT
        ${identifierArrayExpression(table, "activityIds")} AS activity_ids,
        ${identifierArrayExpression(table, "operationIds")} AS operation_ids,
        ${identifierArrayExpression(table, "recordIds")} AS record_ids,
        ${identifierArrayExpression(table, "sleepIds")} AS sleep_ids,
        ${identifierArrayExpression(table, "stringRelationIds")} AS string_relation_ids
      FROM ${qualifiedTable(table.database, table.name)}
      WHERE ${predicate.sql}`,
    query_params: predicate.queryParameters,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const [captured] = capturedIdentifiersSchema.parse(await result.json());
  return captured;
}

function addIdentifiers(target: Set<string>, identifiers: string[]): boolean {
  const sizeBefore = target.size;
  for (const identifier of identifiers) {
    target.add(identifier);
  }
  return target.size !== sizeBefore;
}

function mergeCapturedIdentifiers(
  state: IdentifierState,
  captured: z.infer<typeof capturedIdentifiersSchema>[number],
): boolean {
  const changes = [
    addIdentifiers(state.activityIds, captured.activity_ids),
    addIdentifiers(state.operationIds, captured.operation_ids),
    addIdentifiers(state.recordIds, captured.record_ids),
    addIdentifiers(state.sleepIds, captured.sleep_ids),
    addIdentifiers(state.stringRelationIds, captured.string_relation_ids),
  ];
  return changes.some(Boolean);
}

async function expandIdentifiersToFixpoint(
  client: AccountErasureClickHouseClient,
  tables: readonly PhysicalTable[],
  state: IdentifierState,
  maximumPasses: number,
): Promise<void> {
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let changed = false;
    for (const table of tables) {
      const captured = await captureIdentifiersFromTable(client, table, state);
      if (captured && mergeCapturedIdentifiers(state, captured)) {
        changed = true;
      }
    }
    if (!changed) return;
  }
  throw new Error(
    `ClickHouse account-erasure identifier expansion did not converge within ${maximumPasses} passes`,
  );
}

export async function fenceClickHouseAccount(
  client: AccountErasureClickHouseClient,
  userId: string,
  operationIds: readonly string[],
): Promise<void> {
  const parsedUserId = identifierSchema.parse(userId);
  const parsedOperationIds = z.array(identifierSchema).parse(operationIds);
  const userHash = hashIdentifier(parsedUserId);
  await client.command({
    query: `INSERT INTO ${ACCOUNT_ERASURE_FENCE_TABLE} (user_hash, erased_at)
      VALUES ({user_hash:FixedString(64)}, now64(9))`,
    query_params: { user_hash: userHash },
    clickhouse_settings: { log_queries: 0 },
  });
  const operationHashes = [...new Set(parsedOperationIds.map(hashIdentifier))];
  if (operationHashes.length === 0) return;
  if (!client.insert) {
    throw new Error("ClickHouse account erasure requires insert support");
  }
  await client.insert({
    table: ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
    values: operationHashes.map((operationHash) => ({
      operation_hash: operationHash,
    })),
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
}

export async function eraseClickHouseAccount(
  client: AccountErasureClickHouseClient,
  identifiers: ClickHouseAccountErasureIdentifiers,
  accountErasureOptions: ClickHouseAccountErasureOptions = {},
): Promise<void> {
  if (!client.insert) {
    throw new Error("ClickHouse account erasure requires insert support");
  }
  const parsedIdentifiers = accountErasureIdentifiersSchema.parse({
    activityIds: [...identifiers.activityIds],
    operationIds: [...identifiers.operationIds],
    sleepSessionIds: [...identifiers.sleepSessionIds],
    userId: identifiers.userId,
  });
  const options = resolveOptions(accountErasureOptions);
  await fenceClickHouseAccount(client, parsedIdentifiers.userId, parsedIdentifiers.operationIds);

  const allTables = await listManagedTables(client, options.managedDatabases);
  const personalTables = await validateAndSelectPersonalTables(client, allTables, options);
  const state: IdentifierState = {
    activityIds: new Set(parsedIdentifiers.activityIds),
    operationIds: new Set(parsedIdentifiers.operationIds),
    recordIds: new Set(),
    sleepIds: new Set(parsedIdentifiers.sleepSessionIds),
    stringRelationIds: new Set(),
    userId: parsedIdentifiers.userId,
  };
  await expandIdentifiersToFixpoint(
    client,
    personalTables,
    state,
    options.identifierExpansionMaximumPasses,
  );
  const newlyCapturedOperationIds = [...state.operationIds].filter(
    (operationId) => !parsedIdentifiers.operationIds.includes(operationId),
  );
  if (newlyCapturedOperationIds.length > 0) {
    await fenceClickHouseAccount(client, parsedIdentifiers.userId, newlyCapturedOperationIds);
  }

  const insert = client.insert;
  const piiSafeClient = {
    command: (commandOptions: Parameters<ClickHouseCommandClient["command"]>[0]) =>
      client.command({
        ...commandOptions,
        clickhouse_settings: {
          ...commandOptions.clickhouse_settings,
          log_queries: 0,
        },
      }),
    insert: (insertOptions: Parameters<NonNullable<ClickHouseCommandClient["insert"]>>[0]) =>
      insert({
        ...insertOptions,
        clickhouse_settings: {
          ...insertOptions.clickhouse_settings,
          log_queries: 0,
        },
      }),
    query: (queryOptions: Parameters<AccountErasureClickHouseClient["query"]>[0]) =>
      client.query({
        ...queryOptions,
        clickhouse_settings: {
          ...queryOptions.clickhouse_settings,
          log_queries: 0,
        },
      }),
  };
  await markMetricStreamScopeDeletedInClickHouse(piiSafeClient, {
    userId: parsedIdentifiers.userId,
  });

  const physicalErasureTargets = [];
  for (const table of personalTables) {
    const predicate = personalDataPredicate(table, state);
    if (predicate) {
      physicalErasureTargets.push(await prepareClickHousePhysicalErasure(client, table, predicate));
    }
  }
  for (const target of physicalErasureTargets) {
    await applyClickHousePhysicalErasureMutation(client, target);
  }
  await waitForClickHousePhysicalErasure(client, physicalErasureTargets, {
    pollIntervalMilliseconds: options.physicalPartPollIntervalMilliseconds,
    waitTimeoutMilliseconds: options.physicalPartWaitTimeoutMilliseconds,
  });
}
