import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import { claimAccountErasureRequest } from "../db/account-erasure-processing.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { AccountErasureIdentifierStore } from "./identifier-store.ts";
import { assertNoActivePeerDbMirroredAccountRows } from "./peerdb-mirrored-rows.ts";

describe("bounded PeerDB mirrored account proof", () => {
  const engine = createClickHouseClientFromEnv();
  if (!engine.insert) throw new Error("PeerDB proof fixture requires ClickHouse insert");
  const insert = engine.insert.bind(engine);
  const settings = { log_queries: 0, max_memory_usage: 134217728 };
  const client: ClickHouseClient = {
    ...engine,
    query: (options) =>
      engine.query({
        ...options,
        clickhouse_settings: { ...options.clickhouse_settings, ...settings },
      }),
    command: (options) =>
      engine.command({
        ...options,
        clickhouse_settings: { ...options.clickhouse_settings, ...settings },
      }),
    insert: (options) =>
      insert({ ...options, clickhouse_settings: { ...options.clickhouse_settings, ...settings } }),
  };
  let postgres: TestContext;
  const suffix = randomUUID().replaceAll("-", "");
  const arrays = `r1_erasure_a_${suffix}`;
  const bridges = `r1_erasure_b_${suffix}`;
  const owners = `r1_erasure_c_${suffix}`;
  beforeAll(async () => {
    postgres = await setupTestDatabase();
    const memory = await (
      await client.query<{ memory: string }>({
        query: "SELECT toString(getSetting('max_memory_usage')) AS memory",
        format: "JSONEachRow",
        clickhouse_settings: settings,
      })
    ).json();
    expect(Number(memory[0]?.memory)).toBe(134217728);
    await client.command({
      query: "CREATE DATABASE IF NOT EXISTS postgres_fitness",
      clickhouse_settings: settings,
    });
    for (const [table, columns] of [
      [arrays, "member_activity_ids Array(Nullable(UUID))"],
      [bridges, "operation_id UUID,sleep_session_id Nullable(UUID)"],
      [owners, "user_id Nullable(UUID),activity_id UUID"],
    ])
      await client.command({
        query: `CREATE TABLE postgres_fitness.${table} (row_no UInt64,${columns},version UInt64,_peerdb_is_deleted Int8) ENGINE=ReplacingMergeTree(version) ORDER BY row_no`,
        clickhouse_settings: settings,
      });
  }, 120000);
  afterAll(async () => {
    for (const table of [arrays, bridges, owners])
      await client.command({
        query: `DROP TABLE IF EXISTS postgres_fitness.${table} SYNC`,
        clickhouse_settings: settings,
      });
    await postgres?.cleanup();
    await client.close?.();
  });
  it("checks late canonical pages, nullable owner protection, typed bridges and FINAL tombstones", async () => {
    const userId = randomUUID();
    const otherUser = randomUUID();
    const operation = randomUUID();
    const sleep = randomUUID();
    await postgres.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId}::uuid,'PeerDB fixture')`,
    );
    const accepted = await initiateAccountErasure(
      postgres.db,
      userId,
      async () => "bounded-fixture",
      async () => undefined,
    );
    const leaseOwner = randomUUID();
    await claimAccountErasureRequest(postgres.db, accepted.requestId, leaseOwner, 300000);
    const store = new AccountErasureIdentifierStore(postgres.db, {
      requestId: accepted.requestId,
      leaseOwner,
      pageSize: 500,
    });
    const ids = Array.from({ length: 501 }, () => randomUUID());
    await store.append("activity", ids.slice(0, 500));
    await store.append("activity", ids.slice(500));
    await store.append("operation", [operation]);
    await store.append("sleep", [sleep]);
    await store.sealClosure("initial");
    await store.sealPhysicalPlan("initial", "a".repeat(64));
    const first = await store.readPage("activity");
    if (!first.nextCursor) throw new Error("Fixture must span identity pages");
    const late = (await store.readPage("activity", first.nextCursor)).entries[0]?.value;
    if (!late) throw new Error("Missing late canonical identity");
    if (!client.insert) throw new Error("Fixture requires insert");
    const write = client.insert.bind(client);
    const put = async (table: string, values: readonly object[]) =>
      write({
        table: `postgres_fitness.${table}`,
        values: [...values],
        format: "JSONEachRow",
        clickhouse_settings: settings,
      });
    await put(arrays, [
      { row_no: 1, member_activity_ids: [null, late], version: 1, _peerdb_is_deleted: 0 },
    ]);
    await put(bridges, [
      {
        row_no: 1,
        operation_id: operation,
        sleep_session_id: null,
        version: 1,
        _peerdb_is_deleted: 0,
      },
      {
        row_no: 2,
        operation_id: randomUUID(),
        sleep_session_id: sleep,
        version: 1,
        _peerdb_is_deleted: 0,
      },
    ]);
    await put(owners, [
      { row_no: 1, user_id: otherUser, activity_id: late, version: 1, _peerdb_is_deleted: 0 },
      { row_no: 2, user_id: null, activity_id: late, version: 1, _peerdb_is_deleted: 0 },
      { row_no: 3, user_id: userId, activity_id: randomUUID(), version: 1, _peerdb_is_deleted: 0 },
    ]);
    const verify = () => assertNoActivePeerDbMirroredAccountRows(client, { userId, store });
    await expect(verify()).rejects.toThrow(arrays);
    await put(arrays, [
      { row_no: 1, member_activity_ids: [null, late], version: 2, _peerdb_is_deleted: 1 },
    ]);
    await expect(verify()).rejects.toThrow(bridges);
    await put(bridges, [
      {
        row_no: 1,
        operation_id: operation,
        sleep_session_id: null,
        version: 2,
        _peerdb_is_deleted: 1,
      },
    ]);
    await expect(verify()).rejects.toThrow(bridges);
    await put(bridges, [
      {
        row_no: 2,
        operation_id: randomUUID(),
        sleep_session_id: sleep,
        version: 2,
        _peerdb_is_deleted: 1,
      },
    ]);
    await expect(verify()).rejects.toThrow(owners);
    await put(owners, [
      { row_no: 2, user_id: null, activity_id: late, version: 2, _peerdb_is_deleted: 1 },
    ]);
    await expect(verify()).rejects.toThrow(owners);
    await put(owners, [
      { row_no: 3, user_id: userId, activity_id: randomUUID(), version: 2, _peerdb_is_deleted: 1 },
    ]);
    await expect(verify()).resolves.toBeUndefined();
    const survivors = await (
      await client.query<{ count: string }>({
        query: `SELECT toString(count()) AS count FROM postgres_fitness.${owners} FINAL WHERE user_id={other:UUID} AND _peerdb_is_deleted=0`,
        query_params: { other: otherUser },
        format: "JSONEachRow",
        clickhouse_settings: settings,
      })
    ).json();
    expect(survivors[0]?.count).toBe("1");
  }, 120000);
});
