import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";

const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
const partRowsSchema = z.array(z.object({ part_name: z.string().min(1) }));
const mutationRowsSchema = z.array(z.object({ mutation_id: z.string().min(1) }));
const PHYSICAL_PART_QUERY_BATCH_SIZE = 500;
const nonStorageTableEngines = new Set(["MaterializedView", "Null", "View"]);

export type ClickHouseManagedTableEngineKind = "merge-tree" | "non-storage" | "unsupported-storage";

export function classifyClickHouseManagedTableEngine(
  engine: string,
): ClickHouseManagedTableEngineKind {
  if (nonStorageTableEngines.has(engine)) return "non-storage";
  if (engine.endsWith("MergeTree")) return "merge-tree";
  return "unsupported-storage";
}

export interface ClickHousePhysicalErasureClient {
  command: ClickHouseCommandClient["command"];
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface ClickHousePhysicalErasurePredicate {
  queryParameters: Record<string, unknown>;
  sql: string;
}

export interface ClickHousePhysicalErasureTable {
  database: string;
  name: string;
}

export interface ClickHousePhysicalErasureTarget {
  partNames: Set<string>;
  predicate: ClickHousePhysicalErasurePredicate;
  table: ClickHousePhysicalErasureTable;
}

export interface ClickHousePhysicalErasureOptions {
  pollIntervalMilliseconds: number;
  waitTimeoutMilliseconds: number;
}

function qualifiedTable(table: ClickHousePhysicalErasureTable): string {
  return `\`${table.database}\`.\`${table.name}\``;
}

async function listMatchingActiveParts(
  client: ClickHousePhysicalErasureClient,
  table: ClickHousePhysicalErasureTable,
  predicate: ClickHousePhysicalErasurePredicate,
): Promise<string[]> {
  const result = await client.query({
    query: `SELECT DISTINCT _part AS part_name
      FROM ${qualifiedTable(table)}
      WHERE ${predicate.sql}`,
    query_params: predicate.queryParameters,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return partRowsSchema.parse(await result.json()).map((row) => row.part_name);
}

async function listInactiveParts(
  client: ClickHousePhysicalErasureClient,
  table: ClickHousePhysicalErasureTable,
): Promise<string[]> {
  const result = await client.query({
    query: `SELECT name AS part_name
      FROM system.parts
      WHERE database = {database:String}
        AND table = {table:String}
        AND active = 0`,
    query_params: {
      database: table.database,
      table: table.name,
    },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return partRowsSchema.parse(await result.json()).map((row) => row.part_name);
}

async function assertNoDetachedParts(
  client: ClickHousePhysicalErasureClient,
  table: ClickHousePhysicalErasureTable,
): Promise<void> {
  const result = await client.query({
    query: `SELECT name AS part_name
      FROM system.detached_parts
      WHERE database = {database:String}
        AND table = {table:String}`,
    query_params: {
      database: table.database,
      table: table.name,
    },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const detachedParts = partRowsSchema.parse(await result.json());
  if (detachedParts.length > 0) {
    throw new Error(
      `ClickHouse account erasure cannot prove physical deletion while detached parts remain in ${table.database}.${table.name}`,
    );
  }
}

async function countRowsMatchingPredicate(
  client: ClickHousePhysicalErasureClient,
  table: ClickHousePhysicalErasureTable,
  predicate: ClickHousePhysicalErasurePredicate,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS count
      FROM ${qualifiedTable(table)}
      WHERE ${predicate.sql}`,
    query_params: predicate.queryParameters,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const [row] = countRowsSchema.parse(await result.json());
  return row.count;
}

export async function prepareClickHousePhysicalErasure(
  client: ClickHousePhysicalErasureClient,
  table: ClickHousePhysicalErasureTable,
  predicate: ClickHousePhysicalErasurePredicate,
): Promise<ClickHousePhysicalErasureTarget> {
  await assertNoDetachedParts(client, table);
  return {
    partNames: new Set([
      ...(await listMatchingActiveParts(client, table, predicate)),
      ...(await listInactiveParts(client, table)),
    ]),
    predicate,
    table,
  };
}

export async function applyClickHousePhysicalErasureMutation(
  client: ClickHousePhysicalErasureClient,
  target: ClickHousePhysicalErasureTarget,
): Promise<void> {
  await assertNoDetachedParts(client, target.table);
  const mutationMarker = randomUUID();
  await client.command({
    query: `ALTER TABLE ${qualifiedTable(target.table)}
      DELETE WHERE (${target.predicate.sql})
        AND {account_erasure_mutation_marker:String}
          = {account_erasure_mutation_marker:String}`,
    query_params: {
      ...target.predicate.queryParameters,
      account_erasure_mutation_marker: mutationMarker,
    },
    clickhouse_settings: {
      log_queries: 0,
      mutations_sync: 2,
    },
  });
  const rowsRemaining = await countRowsMatchingPredicate(client, target.table, target.predicate);
  if (rowsRemaining !== 0) {
    throw new Error(
      `ClickHouse account erasure left ${rowsRemaining} row(s) in ${target.table.database}.${target.table.name}`,
    );
  }
  const mutationResult = await client.query({
    query: `SELECT mutation_id
      FROM system.mutations
      WHERE database = {database:String}
        AND table = {table:String}
        AND is_done = 1
        AND position(command, {mutation_marker:String}) > 0`,
    query_params: {
      database: target.table.database,
      mutation_marker: mutationMarker,
      table: target.table.name,
    },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const mutationIds = mutationRowsSchema
    .parse(await mutationResult.json())
    .map((row) => row.mutation_id);
  if (mutationIds.length > 0) {
    await client.command({
      query: `KILL MUTATION
        WHERE database = {database:String}
          AND table = {table:String}
          AND mutation_id IN {mutation_ids:Array(String)}
        SYNC`,
      query_params: {
        database: target.table.database,
        mutation_ids: mutationIds,
        table: target.table.name,
      },
      clickhouse_settings: { log_queries: 0 },
    });
  }
  for (const inactivePart of await listInactiveParts(client, target.table)) {
    target.partNames.add(inactivePart);
  }
  await assertNoDetachedParts(client, target.table);
}

function partReferenceKey(target: ClickHousePhysicalErasureTarget, partName: string): string {
  return `${target.table.database}\u0000${target.table.name}\u0000${partName}`;
}

function collectPartReferences(targets: readonly ClickHousePhysicalErasureTarget[]): string[][] {
  const references = new Map<string, string[]>();
  for (const target of targets) {
    for (const partName of target.partNames) {
      references.set(partReferenceKey(target, partName), [
        target.table.database,
        target.table.name,
        partName,
      ]);
    }
  }
  return [...references.values()];
}

async function countRetainedPartReferences(
  client: ClickHousePhysicalErasureClient,
  references: readonly string[][],
): Promise<number> {
  let retainedCount = 0;
  for (let offset = 0; offset < references.length; offset += PHYSICAL_PART_QUERY_BATCH_SIZE) {
    const referenceBatch = references.slice(offset, offset + PHYSICAL_PART_QUERY_BATCH_SIZE);
    const result = await client.query({
      query: `SELECT count() AS count
        FROM system.parts
        WHERE [database, table, name] IN {
          part_references:Array(Array(String))
        }`,
      query_params: { part_references: referenceBatch },
      format: "JSONEachRow",
      clickhouse_settings: { log_queries: 0 },
    });
    const [row] = countRowsSchema.parse(await result.json());
    retainedCount += row.count;
  }
  return retainedCount;
}

export async function waitForClickHousePhysicalErasure(
  client: ClickHousePhysicalErasureClient,
  targets: readonly ClickHousePhysicalErasureTarget[],
  options: ClickHousePhysicalErasureOptions,
): Promise<void> {
  const references = collectPartReferences(targets);
  for (const target of targets) {
    await assertNoDetachedParts(client, target.table);
  }
  if (references.length === 0) return;
  const deadline = Date.now() + options.waitTimeoutMilliseconds;
  while (Date.now() <= deadline) {
    for (const target of targets) {
      await assertNoDetachedParts(client, target.table);
    }
    if ((await countRetainedPartReferences(client, references)) === 0) {
      for (const target of targets) {
        await assertNoDetachedParts(client, target.table);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMilliseconds));
  }
  throw new Error(
    `ClickHouse account erasure timed out waiting for ${references.length} physical part(s) to be removed`,
  );
}
