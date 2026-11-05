import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import type { AccountErasureIdentifierStore } from "./identifier-store.ts";
import type {
  AccountErasurePhysicalIntent,
  AccountErasurePhysicalMutation,
  AccountErasurePhysicalStage,
} from "./retained-state.ts";

const countSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
const nameRowsSchema = z
  .array(z.object({ value: z.string().base64(), key: z.string().regex(/^[a-f0-9]{64}$/) }))
  .max(64);
const settings = { log_queries: 0 };
const nonStorageTableEngines = new Set(["MaterializedView", "Null", "View"]);
export type ClickHouseManagedTableEngineKind = "merge-tree" | "non-storage" | "unsupported-storage";
export function classifyClickHouseManagedTableEngine(
  engine: string,
): ClickHouseManagedTableEngineKind {
  if (nonStorageTableEngines.has(engine)) return "non-storage";
  return engine.endsWith("MergeTree") ? "merge-tree" : "unsupported-storage";
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
  mutationQueryParameters: Record<string, unknown>;
  mutationSql: string;
  queryParameters: Record<string, unknown>;
  sql: string;
}
interface ResolvedIntent {
  intent: AccountErasurePhysicalIntent;
  predicate: ClickHousePhysicalErasurePredicate;
}
export interface ClickHousePhysicalErasureOptions {
  pollIntervalMilliseconds: number;
  waitTimeoutMilliseconds: number;
  maximumPasses: number;
}
type Owner = Pick<AnalyticsQueryOwner, "client" | "assertActive">;
const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tableSql = (intent: AccountErasurePhysicalIntent) => `\`${intent[1]}\`.\`${intent[2]}\``;
const tableParameters = (intent: AccountErasurePhysicalIntent) => ({
  database: intent[1],
  table: intent[2],
  table_uuid: intent[3],
});
async function count(
  client: ClickHousePhysicalErasureClient,
  query: string,
  params: Record<string, unknown>,
): Promise<number> {
  const [row] = countSchema.parse(
    await (
      await client.query({
        query,
        query_params: params,
        format: "JSONEachRow",
        clickhouse_settings: settings,
      })
    ).json(),
  );
  return row.count;
}
export async function assertNoClickHouseDetachedParts(
  owner: Owner,
  table: { database: string; name: string },
): Promise<void> {
  if (
    await count(
      owner.client,
      "SELECT count() AS count FROM system.detached_parts WHERE database={database:String} AND table={table:String}",
      { database: table.database, table: table.name },
    )
  )
    throw new Error(
      `ClickHouse account erasure cannot prove physical deletion while detached parts remain in ${table.database}.${table.name}`,
    );
}
async function residue(owner: Owner, resolved: ResolvedIntent): Promise<number> {
  return count(
    owner.client,
    `SELECT count() AS count FROM ${tableSql(resolved.intent)} WHERE ${resolved.predicate.sql}`,
    resolved.predicate.queryParameters,
  );
}
/** Native candidates are bounded before base64 encoding; only fixed-width hashes cross the keyset boundary. */
async function* names(
  owner: Owner,
  source: string,
  parameters: Record<string, unknown>,
): AsyncGenerator<string[]> {
  await owner.assertActive();
  const oversized = await count(
    owner.client,
    `SELECT count() AS count FROM (${source}) WHERE length(value)>4096`,
    parameters,
  );
  if (oversized)
    throw new Error(
      "Account erasure physical name exceeds its 4 KiB domain; contact support before retrying",
    );
  let after = "";
  while (true) {
    await owner.assertActive();
    const rows = nameRowsSchema.parse(
      await (
        await owner.client.query({
          query: `SELECT base64Encode(value) AS value,key FROM (
        SELECT value,lower(hex(SHA256(value))) AS key FROM (${source})
        WHERE key>{physical_after: String} ORDER BY key LIMIT 64)`,
          query_params: { ...parameters, physical_after: after },
          format: "JSONEachRow",
          clickhouse_settings: settings,
        })
      ).json(),
    );
    if (!rows.length) return;
    if (
      rows.reduce((bytes, row) => bytes + Buffer.from(row.value, "base64").length, 0) >
        256 * 1024 ||
      Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024
    )
      throw new Error(
        "Account erasure physical page exceeds its byte budget; contact support before retrying",
      );
    yield rows.map((row) => row.value);
    if (rows.length < 64) return;
    after = rows.at(-1)?.key ?? "";
  }
}
async function retainNames(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  intent: AccountErasurePhysicalIntent,
  source: string,
  parameters: Record<string, unknown>,
): Promise<boolean> {
  let changed = false;
  for await (const page of names(owner, source, parameters))
    changed =
      (await store.appendPhysical(
        "physical_part",
        intent[0],
        page.map((value) => [intent[0], intent[1], intent[2], intent[3], value] as const),
      )) || changed;
  return changed;
}
/** Missing retained history is a blocked proof, never evidence that predecessor bytes disappeared. */
async function completeLineage(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  stage: AccountErasurePhysicalStage,
  maximumPasses: number,
): Promise<void> {
  for (let pass = 0; pass < maximumPasses; pass++) {
    let changed = false;
    let cursor: string | undefined;
    do {
      const page = await store.readPhysicalPage("physical_part", stage, cursor);
      // A metadata page is at most64 records. Grouping it never grows with the account.
      const tables = new Map<string, typeof page.entries>();
      for (const entry of page.entries) {
        const key = JSON.stringify(entry.value.slice(1, 4));
        const group = tables.get(key) ?? [];
        group.push(entry);
        tables.set(key, group);
      }
      for (const entries of tables.values()) {
        const first = entries[0];
        if (!first) continue;
        const [, database, table, uuid] = first.value;
        const parameters = {
          database,
          table,
          table_uuid: uuid,
          part_hashes: entries.map((entry) => hashBytes(Buffer.from(entry.value[4], "base64"))),
        };
        // Physical UUID survives pre-seal RENAME/EXCHANGE; historical names do not.
        const history = `SELECT * FROM system.part_log WHERE table_uuid={table_uuid:UUID} AND error=0
          AND event_type IN ('NewPart','DownloadPart','MergeParts','MutatePart')
          AND lower(hex(SHA256(part_name))) IN {part_hashes:Array(String)}`;
        if (
          (await count(
            owner.client,
            `SELECT uniqExact(part_name) AS count FROM (${history})`,
            parameters,
          )) !== entries.length
        )
          throw new Error(
            `ClickHouse account erasure retained part history is incomplete in ${database}.${table}; contact support before retrying`,
          );
        const intent = [stage, database, table, uuid, "0".repeat(64), "user"] as const;
        changed =
          (await retainNames(
            owner,
            store,
            intent,
            `SELECT source AS value FROM (${history}) ARRAY JOIN merged_from AS source`,
            parameters,
          )) || changed;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!changed) return;
  }
  throw new Error("ClickHouse account erasure physical lineage did not converge");
}
async function captureTarget(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  resolved: ResolvedIntent,
): Promise<void> {
  await assertNoClickHouseDetachedParts(owner, {
    database: resolved.intent[1],
    name: resolved.intent[2],
  });
  await retainNames(
    owner,
    store,
    resolved.intent,
    `SELECT _part AS value FROM ${tableSql(resolved.intent)} WHERE ${resolved.predicate.sql}`,
    resolved.predicate.queryParameters,
  );
}
/** Historical unreadable parts can contain this account even when logical residue is zero. */
export async function prepareClickHousePhysicalBaseline(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  intent: AccountErasurePhysicalIntent,
): Promise<void> {
  await assertNoClickHouseDetachedParts(owner, { database: intent[1], name: intent[2] });
  for (const [systemTable, column] of [
    ["parts", "name"],
    ["projection_parts", "parent_name"],
  ] as const)
    await retainNames(
      owner,
      store,
      intent,
      `SELECT ${column} AS value FROM (
      SELECT database,table,${column},_state FROM system.${systemTable})
      WHERE database={database:String} AND table={table:String} AND _state!='Active'`,
      tableParameters(intent),
    );
}
export async function prepareClickHousePhysicalErasure(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  resolved: ResolvedIntent,
): Promise<void> {
  await owner.assertActive();
  await store.appendPhysical("physical_intent", resolved.intent[0], [resolved.intent]);
  await captureTarget(owner, store, resolved);
}
export async function sealClickHousePhysicalErasure(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  stage: AccountErasurePhysicalStage,
  schemaDigest: string,
  maximumPasses: number,
): Promise<void> {
  await owner.client.command({ query: "SYSTEM FLUSH LOGS", clickhouse_settings: settings });
  await completeLineage(owner, store, stage, maximumPasses);
  await owner.assertActive();
  await store.sealPhysicalPlan(stage, schemaDigest);
}
async function recoverMutation(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  resolved: ResolvedIntent,
  intentKey: string,
  options: ClickHousePhysicalErasureOptions,
): Promise<void> {
  const parameters = { ...tableParameters(resolved.intent), marker: intentKey };
  const source = `SELECT mutation_id AS value FROM system.mutations WHERE database={database:String} AND table={table:String} AND position(command,{marker:String})>0`;
  const deadline = Date.now() + options.waitTimeoutMilliseconds;
  while (true) {
    await owner.assertActive();
    const bad = await count(
      owner.client,
      `SELECT count() AS count FROM system.mutations WHERE database={database:String} AND table={table:String} AND position(command,{marker:String})>0 AND (is_done=0 OR latest_fail_reason!='')`,
      parameters,
    );
    if (!bad) break;
    if (Date.now() >= deadline)
      throw new Error(
        "ClickHouse account erasure native mutation is incomplete; contact support before retrying",
      );
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMilliseconds));
  }
  let found = false;
  for await (const page of names(owner, source, parameters)) {
    found = true;
    await store.appendPhysical(
      "physical_mutation",
      resolved.intent[0],
      page.map((value) => [resolved.intent[0], intentKey, value] as const),
    );
    await owner.client.command({ query: "SYSTEM FLUSH LOGS", clickhouse_settings: settings });
    for (const mutation of page) {
      const params = {
        ...tableParameters(resolved.intent),
        mutation_hash: hashBytes(Buffer.from(mutation, "base64")),
      };
      const history = `SELECT * FROM system.part_log WHERE table_uuid={table_uuid:UUID}
        AND event_type='MutatePart' AND error=0 AND arrayExists(id->lower(hex(SHA256(id)))={mutation_hash:String},mutation_ids)`;
      if (!(await count(owner.client, `SELECT count() AS count FROM (${history})`, params)))
        throw new Error(
          "ClickHouse account erasure mutation history is unavailable; contact support before retrying",
        );
      await retainNames(
        owner,
        store,
        resolved.intent,
        `SELECT source AS value FROM (${history}) ARRAY JOIN merged_from AS source`,
        params,
      );
    }
  }
  if (!found)
    throw new Error(
      "ClickHouse account erasure admitted mutation evidence is unavailable; contact support before retrying",
    );
  if (await residue(owner, resolved))
    throw new Error(
      `ClickHouse account erasure left rows in ${resolved.intent[1]}.${resolved.intent[2]}`,
    );
}
async function nextIntent(
  store: AccountErasureIdentifierStore,
  stage: AccountErasurePhysicalStage,
  after: string | null,
) {
  let cursor = after ?? undefined;
  do {
    const page = await store.readPhysicalPage("physical_intent", stage, cursor);
    if (page.entries.length) return page.entries[0];
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}
async function retainedParts(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  stage: AccountErasurePhysicalStage,
): Promise<number> {
  let retained = 0;
  let cursor: string | undefined;
  do {
    const page = await store.readPhysicalPage("physical_part", stage, cursor);
    for (const entry of page.entries) {
      const [, database, table, , value] = entry.value;
      const parameters = { database, table, part_hash: hashBytes(Buffer.from(value, "base64")) };
      for (const [systemTable, column] of [
        ["parts", "name"],
        ["projection_parts", "parent_name"],
      ] as const) {
        // min(_state) keeps the virtual column in the innermost storage read even
        // under projection pruning. No active-state filter may hide Deleting files.
        const result = await owner.client.query({
          query: `SELECT count() AS count,min(_state) AS state FROM (
          SELECT database,table,${column},_state FROM system.${systemTable})
          WHERE database={database:String} AND table={table:String} AND lower(hex(SHA256(${column})))={part_hash:String}`,
          query_params: parameters,
          format: "JSONEachRow",
          clickhouse_settings: settings,
        });
        const [row] = z
          .tuple([z.object({ count: z.coerce.number().int().nonnegative(), state: z.string() })])
          .parse(await result.json());
        retained += row.count;
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return retained;
}
/** Apply every frozen predicate before one global physical proof; only its durable certificate admits cleanup. */
export async function executeClickHousePhysicalErasure(
  owner: Owner,
  store: AccountErasureIdentifierStore,
  stage: AccountErasurePhysicalStage,
  resolveIntent: (intent: AccountErasurePhysicalIntent) => Promise<ResolvedIntent>,
  assertSchema: () => Promise<void>,
  options: ClickHousePhysicalErasureOptions,
): Promise<void> {
  await assertSchema();
  while (true) {
    await owner.assertActive();
    const progress = await store.loadPhysicalProgress(stage);
    if (!progress) throw new Error("ClickHouse physical erasure plan is not prepared");
    if (progress.step !== "apply") break;
    const entry = progress.pending
      ? await store.readPhysicalEntry("physical_intent", stage, progress.pending.intentKey)
      : await nextIntent(store, stage, progress.afterIntentKey);
    if (!entry) {
      await completeLineage(owner, store, stage, options.maximumPasses);
      await store.finishPhysicalApply(stage, progress.afterIntentKey);
      break;
    }
    const resolved = await resolveIntent(entry.value);
    await assertNoClickHouseDetachedParts(owner, {
      database: resolved.intent[1],
      name: resolved.intent[2],
    });
    await store.startPhysicalIntent(stage, {
      expectedAfterKey: progress.afterIntentKey,
      intentKey: entry.key,
    });
    if (!progress.pending?.admitted) {
      if (!(await residue(owner, resolved))) {
        await store.finishPhysicalIntent(stage, entry.key);
        continue;
      }
      await captureTarget(owner, store, resolved);
      await owner.client.command({ query: "SYSTEM FLUSH LOGS", clickhouse_settings: settings });
      await completeLineage(owner, store, stage, options.maximumPasses);
      await owner.assertActive();
      if (await store.admitPhysicalIntent(stage, entry.key)) {
        await owner.client.command({
          query: `ALTER TABLE ${tableSql(entry.value)} DELETE WHERE (${resolved.predicate.mutationSql}) AND '${entry.key}'='${entry.key}'`,
          query_params: resolved.predicate.mutationQueryParameters,
          clickhouse_settings: { ...settings, mutations_sync: 2 },
        });
      }
    }
    await recoverMutation(owner, store, resolved, entry.key, options);
    await store.finishPhysicalIntent(stage, entry.key);
  }
  if ((await store.loadPhysicalProgress(stage))?.step === "physical") {
    const deadline = Date.now() + options.waitTimeoutMilliseconds;
    while (true) {
      await owner.assertActive();
      await assertSchema();
      let cursor: string | undefined;
      do {
        const page = await store.readPhysicalPage("physical_intent", stage, cursor);
        for (const entry of page.entries) {
          const resolved = await resolveIntent(entry.value);
          await assertNoClickHouseDetachedParts(owner, {
            database: resolved.intent[1],
            name: resolved.intent[2],
          });
          if (await residue(owner, resolved))
            throw new Error(
              "ClickHouse account erasure logical residue prevents physical completion",
            );
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (!(await retainedParts(owner, store, stage))) {
        await assertSchema();
        await owner.assertActive();
        await store.markPhysicalComplete(stage);
        break;
      }
      if (Date.now() >= deadline)
        throw new Error(
          "ClickHouse account erasure timed out waiting for all-state physical parts to be removed",
        );
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMilliseconds));
    }
  }
  while (true) {
    await owner.assertActive();
    const progress = await store.loadPhysicalProgress(stage);
    if (progress?.step === "complete") return;
    if (progress?.step !== "cleanup")
      throw new Error("Native metadata cleanup requires durable global physical completion");
    let cursor = progress.afterMutationKey ?? undefined;
    let entry: { key: string; value: AccountErasurePhysicalMutation } | undefined;
    do {
      const page = await store.readPhysicalPage("physical_mutation", stage, cursor);
      entry = page.entries[0];
      if (entry) break;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!entry) {
      await store.finishPhysicalCleanup(stage, progress.afterMutationKey);
      return;
    }
    const parent = await store.readPhysicalEntry("physical_intent", stage, entry.value[1]);
    if (!parent) throw new Error("Native mutation cleanup lost its frozen physical intent");
    const resolved = await resolveIntent(parent.value);
    const parameters = {
      ...tableParameters(resolved.intent),
      mutation_hash: hashBytes(Buffer.from(entry.value[2], "base64")),
    };
    const where =
      "database={database:String} AND table={table:String} AND lower(hex(SHA256(mutation_id)))={mutation_hash:String}";
    const before = await count(
      owner.client,
      `SELECT count() AS count FROM system.mutations WHERE ${where}`,
      parameters,
    );
    if (before) {
      if (
        before !== 1 ||
        (await count(
          owner.client,
          `SELECT count() AS count FROM system.mutations WHERE ${where} AND (is_done=0 OR latest_fail_reason!='')`,
          parameters,
        ))
      )
        throw new Error(
          "ClickHouse native mutation metadata is not uniquely completed; contact support before retrying",
        );
      await owner.client.command({
        query: `KILL MUTATION WHERE ${where}`,
        query_params: parameters,
        clickhouse_settings: settings,
      });
    }
    if (
      await count(
        owner.client,
        `SELECT count() AS count FROM system.mutations WHERE ${where}`,
        parameters,
      )
    )
      throw new Error(
        "ClickHouse completed mutation metadata remains after cleanup; contact support before retrying",
      );
    await store.retirePhysicalMutation(stage, {
      key: entry.key,
      expectedAfterKey: progress.afterMutationKey,
    });
  }
}
