import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../db/clickhouse-metric-stream-bootstrap.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import { eraseClickHouseAccount } from "./clickhouse-erasure.ts";

const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
const partRowsSchema = z.array(z.object({ part_name: z.string().min(1) }));
const stringRowsSchema = z.array(z.object({ value: z.string() }));

function databaseName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function queryCount(
  client: ClickHouseClient,
  query: string,
  queryParameters: Record<string, unknown> = {},
): Promise<number> {
  const result = await client.query({
    query,
    query_params: queryParameters,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const [row] = countRowsSchema.parse(await result.json());
  return row.count;
}

async function tableValues(
  client: ClickHouseClient,
  database: string,
  table: string,
): Promise<string[]> {
  const result = await client.query({
    query: `SELECT value
      FROM \`${database}\`.\`${table}\`
      ORDER BY value`,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return stringRowsSchema.parse(await result.json()).map((row) => row.value);
}

async function createDatabase(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({
    query: `CREATE DATABASE \`${database}\``,
    clickhouse_settings: { log_queries: 0 },
  });
}

async function dropDatabase(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({
    query: `DROP DATABASE IF EXISTS \`${database}\``,
    clickhouse_settings: { log_queries: 0 },
  });
}

async function cleanFences(
  client: ClickHouseClient,
  userId: string,
  operationIds: readonly string[],
): Promise<void> {
  const userHash = createHash("sha256").update(userId).digest("hex");
  const operationHashes = operationIds.map((operationId) =>
    createHash("sha256").update(operationId).digest("hex"),
  );
  await client.command({
    query: `ALTER TABLE ${ACCOUNT_ERASURE_FENCE_TABLE}
      DELETE WHERE user_hash = {user_hash:FixedString(64)}
      SETTINGS mutations_sync = 2`,
    query_params: { user_hash: userHash },
    clickhouse_settings: { log_queries: 0 },
  });
  if (operationHashes.length > 0) {
    await client.command({
      query: `ALTER TABLE ${ACCOUNT_ERASURE_OPERATION_FENCE_TABLE}
        DELETE WHERE operation_hash IN {operation_hashes:Array(String)}
        SETTINGS mutations_sync = 2`,
      query_params: { operation_hashes: operationHashes },
      clickhouse_settings: { log_queries: 0 },
    });
  }
}

describe("ClickHouse account erasure (integration)", () => {
  const client = createClickHouseClientFromEnv();

  beforeAll(async () => {
    for (const statement of buildClickHouseBootstrapStatementsForNativeMetricStream("")) {
      await client.command({
        query: statement,
        clickhouse_settings: { log_queries: 0 },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await client.close?.();
  });

  it("erases current provider and heart-rate read models while preserving the cutover marker", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const sleepId = randomUUID();
    const otherSleepId = randomUUID();

    await client.command({
      query: `CREATE TABLE IF NOT EXISTS analytics.provider_change_state (
          user_id UUID,
          provider_id String,
          changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
        )
        ENGINE = AggregatingMergeTree
        ORDER BY (user_id, provider_id)
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
      clickhouse_settings: { log_queries: 0 },
    });
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS analytics.heart_rate_day_change (
          user_id UUID,
          recorded_date Date,
          changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
        )
        ENGINE = AggregatingMergeTree
        ORDER BY (user_id, recorded_date)
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
      clickhouse_settings: { log_queries: 0 },
    });
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_cutover (
          cutover_at DateTime64(9, 'UTC')
        )
        ENGINE = TinyLog`,
      clickhouse_settings: { log_queries: 0 },
    });
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_window (
          sleep_id UUID,
          user_id UUID,
          started_at DateTime64(6, 'UTC'),
          ended_at DateTime64(6, 'UTC'),
          duration_seconds Int64,
          eligible_sample_count UInt64,
          source_changed_at DateTime64(9, 'UTC'),
          refresh_version UInt64,
          is_deleted UInt8,
          refreshed_at DateTime64(9, 'UTC')
        )
        ENGINE = ReplacingMergeTree(refresh_version)
        ORDER BY (user_id, sleep_id)
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
      clickhouse_settings: { log_queries: 0 },
    });

    try {
      await client.command({
        query: `INSERT INTO analytics.provider_change_state
            (user_id, provider_id, changed_at)
          VALUES
            ({user_id:UUID}, 'garmin', now64(9)),
            ({other_user_id:UUID}, 'garmin', now64(9))`,
        query_params: { other_user_id: otherUserId, user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO analytics.heart_rate_day_change
            (user_id, recorded_date, changed_at)
          VALUES
            ({user_id:UUID}, today(), now64(9)),
            ({other_user_id:UUID}, today(), now64(9))`,
        query_params: { other_user_id: otherUserId, user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO analytics.sleep_heart_rate_cutover (cutover_at)
          VALUES (now64(9))`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO analytics.sleep_heart_rate_window (
            sleep_id,
            user_id,
            started_at,
            ended_at,
            duration_seconds,
            eligible_sample_count,
            source_changed_at,
            refresh_version,
            is_deleted,
            refreshed_at
          )
          VALUES
            (
              {sleep_id:UUID},
              {user_id:UUID},
              now64(6) - INTERVAL 8 HOUR,
              now64(6),
              28800,
              100,
              now64(9),
              1,
              0,
              now64(9)
            ),
            (
              {other_sleep_id:UUID},
              {other_user_id:UUID},
              now64(6) - INTERVAL 8 HOUR,
              now64(6),
              28800,
              100,
              now64(9),
              1,
              0,
              now64(9)
            )`,
        query_params: {
          other_sleep_id: otherSleepId,
          other_user_id: otherUserId,
          sleep_id: sleepId,
          user_id: userId,
        },
        clickhouse_settings: { log_queries: 0 },
      });

      const cutoverCountBefore = await queryCount(
        client,
        "SELECT count() AS count FROM analytics.sleep_heart_rate_cutover",
      );
      await eraseClickHouseAccount(
        client,
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [sleepId],
          userId,
        },
        {
          physicalPartPollIntervalMilliseconds: 1_000,
          physicalPartWaitTimeoutMilliseconds: 45_000,
        },
      );

      await expect(
        queryCount(
          client,
          "SELECT count() AS count FROM analytics.provider_change_state WHERE user_id = {user_id:UUID}",
          { user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          "SELECT count() AS count FROM analytics.heart_rate_day_change WHERE user_id = {user_id:UUID}",
          { user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          "SELECT count() AS count FROM analytics.sleep_heart_rate_window WHERE user_id = {user_id:UUID}",
          { user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          "SELECT count() AS count FROM analytics.sleep_heart_rate_window WHERE user_id = {user_id:UUID}",
          { user_id: otherUserId },
        ),
      ).resolves.toBe(1);
      await expect(
        queryCount(client, "SELECT count() AS count FROM analytics.sleep_heart_rate_cutover"),
      ).resolves.toBe(cutoverCountBefore);
    } finally {
      await cleanFences(client, userId, []);
      await client.command({
        query: `ALTER TABLE analytics.provider_change_state
          DELETE WHERE user_id IN {user_ids:Array(UUID)}
          SETTINGS mutations_sync = 2`,
        query_params: { user_ids: [userId, otherUserId] },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `ALTER TABLE analytics.heart_rate_day_change
          DELETE WHERE user_id IN {user_ids:Array(UUID)}
          SETTINGS mutations_sync = 2`,
        query_params: { user_ids: [userId, otherUserId] },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `ALTER TABLE analytics.sleep_heart_rate_window
          DELETE WHERE user_id IN {user_ids:Array(UUID)}
          SETTINGS mutations_sync = 2`,
        query_params: { user_ids: [userId, otherUserId] },
        clickhouse_settings: { log_queries: 0 },
      });
    }
  }, 120_000);

  it("erases direct and transitive rows while preserving another user and an unmanaged database", async () => {
    const managedDatabase = databaseName("account_erasure_managed");
    const unrelatedDatabase = databaseName("account_erasure_unmanaged");
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const directRecordId = randomUUID();
    const otherRecordId = randomUUID();
    const activityId = randomUUID();
    const linkedActivityId = randomUUID();
    const otherActivityId = randomUUID();
    const sleepSessionId = randomUUID();
    const otherSleepSessionId = randomUUID();
    const operationId = randomUUID();
    const otherOperationId = randomUUID();

    await createDatabase(client, managedDatabase);
    await createDatabase(client, unrelatedDatabase);
    try {
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.account_rows (
          id UUID,
          user_id UUID,
          activity_id UUID,
          sleep_id UUID,
          operation_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.activity_links (
          activity_id UUID,
          linked_activity_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY (activity_id, linked_activity_id)
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.indirect_activity_rows (
          linked_activity_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY linked_activity_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.sleep_rows (
          session_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY session_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.processing_rows (
          operation_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY operation_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${unrelatedDatabase}\`.account_rows (
          user_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY user_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) {
        throw new Error("ClickHouse integration client requires insert support");
      }
      await client.insert({
        table: `${managedDatabase}.account_rows`,
        values: [
          {
            id: directRecordId,
            user_id: userId,
            activity_id: activityId,
            sleep_id: sleepSessionId,
            operation_id: operationId,
            value: "delete-direct",
          },
          {
            id: otherRecordId,
            user_id: otherUserId,
            activity_id: otherActivityId,
            sleep_id: otherSleepSessionId,
            operation_id: otherOperationId,
            value: "keep-other-user",
          },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.activity_links`,
        values: [
          {
            activity_id: activityId,
            linked_activity_id: linkedActivityId,
            value: "delete-link",
          },
          {
            activity_id: otherActivityId,
            linked_activity_id: otherActivityId,
            value: "keep-other-link",
          },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.indirect_activity_rows`,
        values: [
          {
            linked_activity_id: linkedActivityId,
            value: "delete-indirect",
          },
          {
            linked_activity_id: otherActivityId,
            value: "keep-other-indirect",
          },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.sleep_rows`,
        values: [
          { session_id: sleepSessionId, value: "delete-sleep" },
          { session_id: otherSleepSessionId, value: "keep-other-sleep" },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.processing_rows`,
        values: [
          { operation_id: operationId, value: "delete-processing" },
          {
            operation_id: otherOperationId,
            value: "keep-other-processing",
          },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${unrelatedDatabase}.account_rows`,
        values: [{ user_id: userId, value: "keep-unmanaged" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });

      await eraseClickHouseAccount(
        client,
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
        {
          managedDatabases: [managedDatabase],
          physicalPartPollIntervalMilliseconds: 1_000,
          physicalPartWaitTimeoutMilliseconds: 45_000,
        },
      );

      await expect(tableValues(client, managedDatabase, "account_rows")).resolves.toEqual([
        "keep-other-user",
      ]);
      await expect(tableValues(client, managedDatabase, "activity_links")).resolves.toEqual([
        "keep-other-link",
      ]);
      await expect(tableValues(client, managedDatabase, "indirect_activity_rows")).resolves.toEqual(
        ["keep-other-indirect"],
      );
      await expect(tableValues(client, managedDatabase, "sleep_rows")).resolves.toEqual([
        "keep-other-sleep",
      ]);
      await expect(tableValues(client, managedDatabase, "processing_rows")).resolves.toEqual([
        "keep-other-processing",
      ]);
      await expect(tableValues(client, unrelatedDatabase, "account_rows")).resolves.toEqual([
        "keep-unmanaged",
      ]);
      await expect(
        queryCount(
          client,
          `SELECT count() AS count
            FROM ${ACCOUNT_ERASURE_OPERATION_FENCE_TABLE} FINAL
            WHERE operation_hash = {operation_hash:FixedString(64)}`,
          {
            operation_hash: createHash("sha256").update(operationId).digest("hex"),
          },
        ),
      ).resolves.toBe(1);
    } finally {
      await cleanFences(client, userId, [operationId]);
      await dropDatabase(client, managedDatabase);
      await dropDatabase(client, unrelatedDatabase);
    }
  }, 120_000);

  it("erases a schema-matching orphan dbt staging table and rejects an active one", async () => {
    const managedDatabase = databaseName("account_erasure_dbt");
    const userId = randomUUID();
    const activeUserId = randomUUID();
    const orphanStagingTable = `daily_sleep__dbt_new_data_${randomUUID().replaceAll("-", "_")}`;
    const activeStagingTable = `daily_sleep_active__dbt_new_data_${randomUUID().replaceAll("-", "_")}`;
    await createDatabase(client, managedDatabase);
    try {
      for (const table of [
        "daily_sleep",
        "daily_sleep_active",
        orphanStagingTable,
        activeStagingTable,
      ]) {
        await client.command({
          query: `CREATE TABLE \`${managedDatabase}\`.\`${table}\` (
            user_id UUID,
            value String
          ) ENGINE = MergeTree
          ORDER BY user_id
          SETTINGS
            old_parts_lifetime = 1,
            cleanup_delay_period = 1,
            cleanup_delay_period_random_add = 0,
            max_cleanup_delay_period = 1`,
          clickhouse_settings: { log_queries: 0 },
        });
      }
      if (!client.insert) {
        throw new Error("ClickHouse integration client requires insert support");
      }
      await client.insert({
        table: `${managedDatabase}.daily_sleep`,
        values: [{ user_id: userId, value: "delete-current" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.${orphanStagingTable}`,
        values: [{ user_id: userId, value: "delete-orphan" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.${activeStagingTable}`,
        values: [{ user_id: activeUserId, value: "keep-active" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });

      await eraseClickHouseAccount(
        client,
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
        {
          managedDatabases: [managedDatabase],
          orphanStagingMinimumAgeMilliseconds: 0,
          physicalPartPollIntervalMilliseconds: 1_000,
          physicalPartWaitTimeoutMilliseconds: 45_000,
        },
      );

      await expect(tableValues(client, managedDatabase, "daily_sleep")).resolves.toEqual([]);
      await expect(tableValues(client, managedDatabase, orphanStagingTable)).resolves.toEqual([]);
      await expect(tableValues(client, managedDatabase, activeStagingTable)).resolves.toEqual([
        "keep-active",
      ]);

      await expect(
        eraseClickHouseAccount(
          client,
          {
            activityIds: [],
            operationIds: [],
            sleepSessionIds: [],
            userId: activeUserId,
          },
          {
            managedDatabases: [managedDatabase],
            orphanStagingMinimumAgeMilliseconds: 3_600_000,
            physicalPartPollIntervalMilliseconds: 1_000,
            physicalPartWaitTimeoutMilliseconds: 45_000,
          },
        ),
      ).rejects.toThrow("active dbt staging table");
      await expect(tableValues(client, managedDatabase, activeStagingTable)).resolves.toEqual([
        "keep-active",
      ]);
    } finally {
      await cleanFences(client, userId, []);
      await cleanFences(client, activeUserId, []);
      await dropDatabase(client, managedDatabase);
    }
  }, 120_000);

  it("fails closed on unhandled ownership schema drift before deleting rows", async () => {
    const managedDatabase = databaseName("account_erasure_drift");
    const userId = randomUUID();
    await createDatabase(client, managedDatabase);
    try {
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.known_rows (
          user_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY user_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.new_personal_rows (
          account_id UUID,
          email String
        ) ENGINE = MergeTree
        ORDER BY account_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) {
        throw new Error("ClickHouse integration client requires insert support");
      }
      await client.insert({
        table: `${managedDatabase}.known_rows`,
        values: [{ user_id: userId, value: "must-remain-on-drift" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.new_personal_rows`,
        values: [{ account_id: userId, email: "private@example.test" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });

      await expect(
        eraseClickHouseAccount(
          client,
          {
            activityIds: [],
            operationIds: [],
            sleepSessionIds: [],
            userId,
          },
          {
            managedDatabases: [managedDatabase],
            physicalPartPollIntervalMilliseconds: 1_000,
            physicalPartWaitTimeoutMilliseconds: 45_000,
          },
        ),
      ).rejects.toThrow("account_id");
      await expect(tableValues(client, managedDatabase, "known_rows")).resolves.toEqual([
        "must-remain-on-drift",
      ]);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, managedDatabase);
    }
  }, 120_000);

  it("waits until target-bearing inactive parts are physically absent", async () => {
    const managedDatabase = databaseName("account_erasure_parts");
    const userId = randomUUID();
    await createDatabase(client, managedDatabase);
    try {
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.account_rows (
          user_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY user_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) {
        throw new Error("ClickHouse integration client requires insert support");
      }
      await client.insert({
        table: `${managedDatabase}.account_rows`,
        values: [{ user_id: userId, value: "physically-delete" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      const partResult = await client.query({
        query: `SELECT DISTINCT _part AS part_name
          FROM \`${managedDatabase}\`.account_rows
          WHERE user_id = {user_id:UUID}`,
        query_params: { user_id: userId },
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      const partNames = partRowsSchema.parse(await partResult.json()).map((row) => row.part_name);
      expect(partNames.length).toBeGreaterThan(0);

      await eraseClickHouseAccount(
        client,
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
        {
          managedDatabases: [managedDatabase],
          physicalPartPollIntervalMilliseconds: 1_000,
          physicalPartWaitTimeoutMilliseconds: 45_000,
        },
      );

      await expect(
        queryCount(
          client,
          `SELECT count() AS count
            FROM system.parts
            WHERE database = {database:String}
              AND table = {table:String}
              AND name IN {part_names:Array(String)}`,
          {
            database: managedDatabase,
            part_names: partNames,
            table: "account_rows",
          },
        ),
      ).resolves.toBe(0);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, managedDatabase);
    }
  }, 120_000);

  it("fails closed when a managed personal-data table has a detached physical part", async () => {
    const managedDatabase = databaseName("account_erasure_detached");
    const userId = randomUUID();
    await createDatabase(client, managedDatabase);
    try {
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.account_rows (
          user_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY user_id`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) {
        throw new Error("ClickHouse integration client requires insert support");
      }
      await client.insert({
        table: `${managedDatabase}.account_rows`,
        values: [{ user_id: userId, value: "detached-private-data" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      const partResult = await client.query({
        query: `SELECT DISTINCT _part AS part_name
          FROM \`${managedDatabase}\`.account_rows
          WHERE user_id = {user_id:UUID}`,
        query_params: { user_id: userId },
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      const [partName] = partRowsSchema.parse(await partResult.json()).map((row) => row.part_name);
      const safePartName = z
        .string()
        .regex(/^[A-Za-z0-9_]+$/)
        .parse(partName);
      await client.command({
        query: `ALTER TABLE \`${managedDatabase}\`.account_rows DETACH PART '${safePartName}'`,
        clickhouse_settings: { log_queries: 0 },
      });
      await expect(
        queryCount(
          client,
          `SELECT count() AS count
            FROM system.detached_parts
            WHERE database = {database:String}
              AND table = {table:String}`,
          { database: managedDatabase, table: "account_rows" },
        ),
      ).resolves.toBe(1);

      await expect(
        eraseClickHouseAccount(
          client,
          {
            activityIds: [],
            operationIds: [],
            sleepSessionIds: [],
            userId,
          },
          {
            managedDatabases: [managedDatabase],
            physicalPartPollIntervalMilliseconds: 1_000,
            physicalPartWaitTimeoutMilliseconds: 45_000,
          },
        ),
      ).rejects.toThrow(
        `ClickHouse account erasure cannot prove physical deletion while detached parts remain in ${managedDatabase}.account_rows`,
      );
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, managedDatabase);
    }
  }, 120_000);

  it("does not record account or operation identifiers in the ClickHouse query log", async () => {
    const managedDatabase = databaseName("account_erasure_query_log");
    const userId = randomUUID();
    const operationId = randomUUID();
    await createDatabase(client, managedDatabase);
    try {
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.account_rows (
          user_id UUID,
          operation_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY user_id
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) {
        throw new Error("ClickHouse integration client requires insert support");
      }
      await client.insert({
        table: `${managedDatabase}.account_rows`,
        values: [{ user_id: userId, operation_id: operationId, value: "secret" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });

      await eraseClickHouseAccount(
        client,
        {
          activityIds: [],
          operationIds: [operationId],
          sleepSessionIds: [],
          userId,
        },
        {
          managedDatabases: [managedDatabase],
          physicalPartPollIntervalMilliseconds: 1_000,
          physicalPartWaitTimeoutMilliseconds: 45_000,
        },
      );
      await client.command({
        query: "SYSTEM FLUSH LOGS",
        clickhouse_settings: { log_queries: 0 },
      });

      await expect(
        queryCount(
          client,
          `SELECT count() AS count
            FROM system.query_log
            WHERE position(query, {user_id:String}) > 0
              OR position(query, {operation_id:String}) > 0
              OR position(formatted_query, {user_id:String}) > 0
              OR position(formatted_query, {operation_id:String}) > 0`,
          { operation_id: operationId, user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          `SELECT count() AS count
            FROM system.mutations
            WHERE database = {database:String}
              AND (
                position(command, {user_id:String}) > 0
                OR position(command, {operation_id:String}) > 0
              )`,
          {
            database: managedDatabase,
            operation_id: operationId,
            user_id: userId,
          },
        ),
      ).resolves.toBe(0);
    } finally {
      await cleanFences(client, userId, [operationId]);
      await dropDatabase(client, managedDatabase);
    }
  }, 120_000);
});
