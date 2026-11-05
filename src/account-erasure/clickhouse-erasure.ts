import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import {
  baseTableName,
  clickHouseErasureSchemaDigest,
  columnTypes,
  hasUuidScalarColumn,
  type IdentifierColumnDefinition,
  identifierColumns,
  identifierNameSchema,
  inspectClickHouseAccountErasureCoverage,
  isStructuralEffectReceiptTable,
  isUserProfileTable,
  type PhysicalTable,
  PRODUCTION_MANAGED_DATABASES,
  qualifiedTable,
  type UuidIdentifierFamily,
} from "./clickhouse-erasure-coverage.ts";
import { readClickHouseErasureIdentifierPage } from "./clickhouse-identifier-pages.ts";
import {
  assertNoClickHouseDetachedParts,
  type ClickHousePhysicalErasurePredicate,
  executeClickHousePhysicalErasure,
  prepareClickHousePhysicalBaseline,
  prepareClickHousePhysicalErasure,
  sealClickHousePhysicalErasure,
} from "./clickhouse-physical-erasure.ts";
import type {
  AccountErasureIdentifierFamily,
  AccountErasureIdentifierStore,
} from "./identifier-store.ts";
import {
  ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
  AccountErasureIdentifierBudgetError,
} from "./identifier-store.ts";
import type {
  AccountErasurePhysicalIntent,
  AccountErasurePhysicalStage,
} from "./retained-state.ts";

const DEFAULT_IDENTIFIER_EXPANSION_MAXIMUM_PASSES = 256;
const DEFAULT_ORPHAN_STAGING_MINIMUM_AGE_MILLISECONDS = 15 * 60 * 1_000;
const DEFAULT_PHYSICAL_PART_POLL_INTERVAL_MILLISECONDS = 1_000;
const DEFAULT_PHYSICAL_PART_WAIT_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;

const identifierSchema = z.string().uuid();
const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
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

export interface ClickHouseAccountErasureOptions {
  identifierExpansionMaximumPasses?: number;
  managedDatabases?: readonly string[];
  orphanStagingMinimumAgeMilliseconds?: number;
  physicalPartPollIntervalMilliseconds?: number;
  physicalPartWaitTimeoutMilliseconds?: number;
}
type ResolvedOptions = z.infer<typeof resolvedOptionsSchema>;

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

async function hasActiveTableQuery(
  client: Pick<AccountErasureClickHouseClient, "query">,
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

function hashIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}

function tableIdentityFamilies(table: PhysicalTable): UuidIdentifierFamily[] {
  if (!hasUuidScalarColumn(table, "id") || isUserProfileTable(table)) {
    return [];
  }
  const families: UuidIdentifierFamily[] = [];
  const canonicalName = baseTableName(table);
  if (canonicalName === "activity") {
    families.push("activityIds");
  }
  if (canonicalName === "sleep_session") {
    families.push("sleepIds");
  }
  return families;
}

function retainedFamily(definition: IdentifierColumnDefinition): AccountErasureIdentifierFamily {
  return definition.family === "activityIds"
    ? "activity"
    : definition.family === "sleepIds"
      ? "sleep"
      : definition.family === "operationIds"
        ? "operation"
        : "group_string";
}

function captureColumns(table: PhysicalTable): Array<[string, IdentifierColumnDefinition]> {
  return [
    ...identifierColumns(table),
    ...tableIdentityFamilies(table).map((family): [string, IdentifierColumnDefinition] => [
      "id",
      { family, valueType: "uuid", cardinality: "scalar" },
    ]),
  ];
}

interface BoundedPredicate extends ClickHousePhysicalErasurePredicate {
  binding: AccountErasurePhysicalIntent[5];
}
function userPredicate(table: PhysicalTable, userId: string): BoundedPredicate {
  const column = columnTypes(table).has("user_id") ? "user_id" : "id";
  return {
    binding: "user",
    sql: `${column}={erasure_user_id:UUID}`,
    queryParameters: { erasure_user_id: userId },
    mutationSql: `lower(hex(SHA256(toString(${column}))))={erasure_user_hash:String}`,
    mutationQueryParameters: { erasure_user_hash: hashIdentifier(userId) },
  };
}
function boundedRelationPredicate(
  table: PhysicalTable,
  column: string,
  definition: IdentifierColumnDefinition,
  values: readonly string[],
  binding: AccountErasurePhysicalIntent[5],
): BoundedPredicate {
  const string = definition.valueType === "string";
  const hashes = values.map((value) =>
    createHash("sha256")
      .update(string ? Buffer.from(value, "base64") : value)
      .digest("hex"),
  );
  const expression = string ? `lower(hex(SHA256(assumeNotNull(\`${column}\`))))` : `\`${column}\``;
  const hashed =
    definition.cardinality === "array"
      ? `arrayMap(value->lower(hex(SHA256(toString(value)))),\`${column}\`)`
      : `lower(hex(SHA256(${string ? `assumeNotNull(\`${column}\`)` : `toString(\`${column}\`)`})))`;
  const comparison = (value: string, type: string) =>
    definition.cardinality === "array"
      ? `hasAny(${value},{erasure_relation_ids:Array(${type})})`
      : `${value} IN {erasure_relation_ids:Array(${type})}`;
  const guard =
    columnTypes(table).get("user_id") === "Nullable(UUID)" ? "user_id IS NULL AND " : "";
  return {
    binding,
    sql: guard + comparison(expression, string ? "String" : "UUID"),
    queryParameters: { erasure_relation_ids: string ? hashes : values },
    mutationSql: guard + comparison(hashed, "String"),
    mutationQueryParameters: { erasure_relation_ids: hashes },
  };
}
export async function* clickHouseAccountErasurePredicates(
  table: PhysicalTable,
  userId: string,
  store: Pick<AccountErasureIdentifierStore, "readPage">,
): AsyncGenerator<BoundedPredicate> {
  const ownerType = columnTypes(table).get("user_id");
  if (
    ownerType === "UUID" ||
    (ownerType === undefined && isUserProfileTable(table) && hasUuidScalarColumn(table, "id"))
  ) {
    yield userPredicate(table, userId);
    return;
  }
  if (ownerType === "Nullable(UUID)") yield userPredicate(table, userId);
  for (const [column, definition] of captureColumns(table)) {
    let cursor: string | undefined;
    do {
      const family = retainedFamily(definition);
      const page = await store.readPage(family, cursor);
      const upper = page.entries.at(-1)?.key;
      if (upper)
        yield boundedRelationPredicate(
          table,
          column,
          definition,
          page.entries.map((entry) => entry.value),
          [column, family, cursor ?? null, upper],
        );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}

async function assertErasableTables(
  client: AccountErasureClickHouseClient,
  tables: readonly PhysicalTable[],
  options: ResolvedOptions,
): Promise<void> {
  for (const table of tables) {
    if (
      baseTableName(table) !== table.name &&
      (table.age_milliseconds < options.orphanStagingMinimumAgeMilliseconds ||
        (await hasActiveTableQuery(client, table)))
    )
      throw new Error(`Cannot erase an active dbt staging table: ${table.database}.${table.name}`);
  }
}

/** Complete identity discovery under the writer owner before any parent is removed. */
export async function prepareClickHouseAccountErasureIdentifiers(
  owner: Pick<AnalyticsQueryOwner, "client" | "assertActive">,
  store: AccountErasureIdentifierStore,
  input: { userId: string; stage: "initial" | "final" },
  accountErasureOptions: ClickHouseAccountErasureOptions = {},
): Promise<void> {
  const userId = identifierSchema.parse(input.userId);
  await owner.assertActive();
  if (!(await store.beginClosure(input.stage))) return;
  const options = resolveOptions(accountErasureOptions);
  const tables = await inspectClickHouseAccountErasureCoverage(owner.client, options);
  await assertErasableTables(owner.client, tables, options);
  for (let pass = 0; pass < options.identifierExpansionMaximumPasses; pass += 1) {
    let changed = false;
    for (const table of tables) {
      const columns = captureColumns(table);
      if (columns.length === 0) continue;
      for await (const predicate of clickHouseAccountErasurePredicates(table, userId, store)) {
        for (const column of columns) {
          let after: string | undefined;
          do {
            await owner.assertActive();
            const page = await readClickHouseErasureIdentifierPage(owner.client, {
              table,
              column,
              predicate,
              after,
            });
            if (page.values.length > 0)
              changed = (await store.append(retainedFamily(column[1]), page.values)) || changed;
            after = page.nextCursor ?? undefined;
          } while (after);
        }
      }
    }
    // Cursors are local: every restart, and every dirty full pass, begins at
    // the start so newly inserted lower HMAC keys cannot be missed by a seal.
    if (!changed) {
      await owner.assertActive();
      await store.sealClosure(input.stage);
      return;
    }
  }
  throw new Error(
    `ClickHouse account-erasure identifier expansion did not converge within ${options.identifierExpansionMaximumPasses} passes`,
  );
}

export async function fenceClickHouseAccount(
  client: AccountErasureClickHouseClient,
  userId: string,
  operationIds: readonly string[],
): Promise<void> {
  if (operationIds.length > ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE)
    throw new AccountErasureIdentifierBudgetError(
      "Account erasure operation fence page exceeds its 500-entry budget",
    );
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

/** Freeze bounded predicates and pre-mutation provenance before destructive phases. */
export async function prepareClickHouseAccountErasure(
  owner: Pick<AnalyticsQueryOwner, "client" | "assertActive">,
  store: AccountErasureIdentifierStore,
  input: { userId: string; stage: AccountErasurePhysicalStage },
  accountErasureOptions: ClickHouseAccountErasureOptions = {},
): Promise<void> {
  await prepareClickHouseAccountErasureIdentifiers(owner, store, input, accountErasureOptions);
  const options = resolveOptions(accountErasureOptions);
  const tables = await inspectClickHouseAccountErasureCoverage(owner.client, options);
  await assertErasableTables(owner.client, tables, options);
  const digest = clickHouseErasureSchemaDigest(tables);
  if (await store.loadPhysicalProgress(input.stage)) {
    await store.assertPhysicalPlanPrepared(input.stage, digest);
    return;
  }
  for (const table of tables) {
    await prepareClickHousePhysicalBaseline(owner, store, [
      input.stage,
      table.database,
      table.name,
      table.uuid,
      clickHouseErasureSchemaDigest([table]),
      "user",
    ]);
    for await (const predicate of clickHouseAccountErasurePredicates(table, input.userId, store)) {
      await prepareClickHousePhysicalErasure(owner, store, {
        intent: [
          input.stage,
          table.database,
          table.name,
          table.uuid,
          clickHouseErasureSchemaDigest([table]),
          predicate.binding,
        ],
        predicate,
      });
    }
  }
  await sealClickHousePhysicalErasure(
    owner,
    store,
    input.stage,
    digest,
    options.identifierExpansionMaximumPasses,
  );
}

export async function eraseClickHouseAccount(
  owner: Pick<AnalyticsQueryOwner, "client" | "assertActive">,
  store: AccountErasureIdentifierStore,
  input: { userId: string; stage: AccountErasurePhysicalStage },
  accountErasureOptions: ClickHouseAccountErasureOptions = {},
): Promise<void> {
  const userId = identifierSchema.parse(input.userId);
  const options = resolveOptions(accountErasureOptions);
  await store.assertClosureComplete(input.stage);
  let currentTables: PhysicalTable[] = [];
  const assertSchema = async () => {
    await owner.assertActive();
    currentTables = await inspectClickHouseAccountErasureCoverage(owner.client, options);
    await assertErasableTables(owner.client, currentTables, options);
    for (const table of currentTables) await assertNoClickHouseDetachedParts(owner, table);
    await store.assertPhysicalPlanPrepared(
      input.stage,
      clickHouseErasureSchemaDigest(currentTables),
    );
  };
  await assertSchema();
  // Fence later CH-discovered operations one bounded canonical page at a time.
  let cursor: string | undefined;
  do {
    const page = await store.readPage("operation", cursor);
    await fenceClickHouseAccount(
      owner.client,
      userId,
      page.entries.map((entry) => entry.value),
    );
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  // The committed fence and shared owner exclude new account effects. Preserve
  // structural references for pending journal-only effects before any payload deletion.
  for (const receipt of currentTables.filter(isStructuralEffectReceiptTable)) {
    const journal = currentTables.find(
      (table) => table.database === receipt.database && table.name === "effect_journal",
    );
    if (!journal)
      throw new Error("Structural receipt preservation requires its account journal table");
    await owner.assertActive();
    await owner.client.command({
      query: `INSERT INTO ${qualifiedTable(receipt.database, receipt.name)}
        (epoch,topic,partition,transport,kafka_offset,major,minor,batch,preparation_attempt,effect_ordinal,stage,effect_hash,is_empty,user_id,outcome)
        SELECT epoch,topic,partition,transport,kafka_offset,major,minor,batch,preparation_attempt,effect_ordinal,stage,effect_hash,0,NULL,'fenced'
        FROM ${qualifiedTable(journal.database, journal.name)} FINAL WHERE user_id={user_id:UUID}`,
      query_params: { user_id: userId },
      clickhouse_settings: { log_queries: 0 },
    });
  }
  await executeClickHousePhysicalErasure(
    owner,
    store,
    input.stage,
    async (intent) => {
      const table = currentTables.find(
        (candidate) => candidate.database === intent[1] && candidate.name === intent[2],
      );
      if (
        !table ||
        table.uuid !== intent[3] ||
        clickHouseErasureSchemaDigest([table]) !== intent[4]
      )
        throw new Error(
          "ClickHouse physical intent table UUID/schema changed; contact support before retrying",
        );
      const binding = intent[5];
      if (binding === "user")
        return {
          intent,
          predicate: userPredicate(table, userId),
          mutation: isStructuralEffectReceiptTable(table)
            ? ("redact-receipt" as const)
            : ("delete" as const),
        };
      const [column, family, lower, upper] = binding;
      const definition = captureColumns(table).find(
        ([name, definition]) => name === column && retainedFamily(definition) === family,
      )?.[1];
      if (!definition) throw new Error("ClickHouse physical intent relationship is unsupported");
      const page = await store.readPage(family, lower ?? undefined, upper);
      if (page.entries.at(-1)?.key !== upper)
        throw new Error("ClickHouse physical intent identity interval is incomplete");
      return {
        intent,
        mutation: "delete" as const,
        predicate: boundedRelationPredicate(
          table,
          column,
          definition,
          page.entries.map((entry) => entry.value),
          binding,
        ),
      };
    },
    assertSchema,
    {
      pollIntervalMilliseconds: options.physicalPartPollIntervalMilliseconds,
      waitTimeoutMilliseconds: options.physicalPartWaitTimeoutMilliseconds,
      maximumPasses: options.identifierExpansionMaximumPasses,
    },
  );
}
