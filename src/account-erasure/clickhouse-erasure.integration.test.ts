import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../analytics/analytics-query-owner.ts";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import {
  claimAccountErasureRequest,
  markAccountErasurePhaseCompleted,
} from "../db/account-erasure-processing.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildIncrementalDedupedSensorBaseTableStatements } from "../db/clickhouse-deduped-sensor.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../db/clickhouse-metric-stream-bootstrap.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { logger } from "../logger.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
  buildIngestMetricStreamCreateTableSql,
} from "../metric-stream/clickhouse-table.ts";
import {
  type ClickHouseAccountErasureOptions,
  eraseClickHouseAccount as executeAccountErasure,
  prepareClickHouseAccountErasure,
  prepareClickHouseAccountErasureIdentifiers,
} from "./clickhouse-erasure.ts";
import { inspectClickHouseAccountErasureCoverage } from "./clickhouse-erasure-coverage.ts";
import { readClickHouseErasureIdentifierPage } from "./clickhouse-identifier-pages.ts";
import { AccountErasureIdentifierStore } from "./identifier-store.ts";
import { erasePostgresAccount } from "./postgres-erasure.ts";
import {
  createEncryptedAccountErasureSnapshot,
  decryptAccountErasureSnapshot,
} from "./remote-snapshot.ts";

const countRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);
const partRowsSchema = z.array(z.object({ part_name: z.string().min(1) }));
const queryLogRowsSchema = z.array(
  z.object({
    formatted_query: z.string(),
    query: z.string(),
  }),
);
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
  let physicalPostgres: TestContext;
  async function physicalFixture(
    userId: string,
    Store: typeof AccountErasureIdentifierStore = AccountErasureIdentifierStore,
  ) {
    await physicalPostgres.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId}::uuid,'Physical fixture') ON CONFLICT DO NOTHING`,
    );
    const accepted = await initiateAccountErasure(
      physicalPostgres.db,
      userId,
      async () => "bounded-snapshot-fixture",
      async () => undefined,
    );
    const leaseOwner = randomUUID();
    await claimAccountErasureRequest(physicalPostgres.db, accepted.requestId, leaseOwner, 300000);
    const store = new Store(physicalPostgres.db, {
      requestId: accepted.requestId,
      leaseOwner,
      pageSize: 500,
    });
    const input = { userId, stage: "initial" as const };
    const run = <T>(
      operation: (
        owner: Parameters<Parameters<typeof withAnalyticsQueryOwner>[3]>[0],
      ) => Promise<T>,
    ) =>
      withAnalyticsQueryOwner(
        physicalPostgres.db,
        client,
        { resourceId: `physical-fixture:${accepted.requestId}`, intentId: accepted.requestId },
        operation,
      );
    return { store, input, run, requestId: accepted.requestId, leaseOwner };
  }
  async function eraseClickHouseAccount(
    _client: ClickHouseClient,
    identifiers: {
      userId: string;
      activityIds: readonly string[];
      operationIds: readonly string[];
      sleepSessionIds: readonly string[];
    },
    options: ClickHouseAccountErasureOptions = {},
  ) {
    const fixture = await physicalFixture(identifiers.userId);
    for (const [family, values] of [
      ["activity", identifiers.activityIds],
      ["operation", identifiers.operationIds],
      ["sleep", identifiers.sleepSessionIds],
    ] as const)
      for (let offset = 0; offset < values.length; offset += 500)
        await fixture.store.append(family, values.slice(offset, offset + 500));
    await fixture.run(async (owner) => {
      await prepareClickHouseAccountErasure(owner, fixture.store, fixture.input, options);
      await executeAccountErasure(owner, fixture.store, fixture.input, options);
    });
  }
  const engine = createClickHouseClientFromEnv();
  if (!engine.insert) throw new Error("ClickHouse integration client requires insert support");
  const insert = engine.insert.bind(engine);
  const queryMemoryLimitBytes = 128 * 1024 * 1024;
  const client: ClickHouseClient = {
    ...engine,
    query: (options) =>
      engine.query({
        ...options,
        clickhouse_settings: {
          ...options.clickhouse_settings,
          max_memory_usage: String(queryMemoryLimitBytes),
        },
      }),
    command: (options) =>
      engine.command({
        ...options,
        clickhouse_settings: {
          ...options.clickhouse_settings,
          max_memory_usage: String(queryMemoryLimitBytes),
        },
      }),
    insert: (options) =>
      insert({
        ...options,
        clickhouse_settings: {
          ...options.clickhouse_settings,
          max_memory_usage: String(queryMemoryLimitBytes),
        },
      }),
  };

  beforeAll(async () => {
    physicalPostgres = await setupTestDatabase();
    expect(
      await queryCount(client, "SELECT toUInt64(getSetting('max_memory_usage')) AS count"),
    ).toBe(queryMemoryLimitBytes);
    for (const statement of [
      ...buildClickHouseBootstrapStatementsForNativeMetricStream(""),
      "CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_cutover (cutover_at DateTime64(9, 'UTC')) ENGINE=TinyLog",
    ]) {
      await client.command({
        query: statement,
        clickhouse_settings: { log_queries: 0 },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await physicalPostgres?.cleanup();
    await client.close?.();
  });

  it("physically erases 400000 and 800000 sensor rows with fixed captured identities and snapshot bytes", async () => {
    const comparisons: Array<{
      families: Array<{ family: string; count: number }>;
      snapshotBytes: number;
      credentialLengths: number[];
    }> = [];
    for (const sensorRows of [400_000, 800_000]) {
      const database = databaseName("account_erasure_resource");
      const userId = randomUUID();
      const survivor = randomUUID();
      const activity = [randomUUID(), randomUUID()];
      const sleep = randomUUID();
      const operation = [randomUUID(), randomUUID()];
      const seedQueries: string[] = [];
      const options = {
        managedDatabases: [database],
        physicalPartPollIntervalMilliseconds: 1000,
        physicalPartWaitTimeoutMilliseconds: 45000,
      };
      await createDatabase(client, database);
      try {
        const scope = (statement: string) =>
          statement.replaceAll("ingest.", `${database}.`).replaceAll("analytics.", `${database}.`);
        for (const statement of [
          buildIngestMetricStreamCreateTableSql(),
          ...buildIncrementalDedupedSensorBaseTableStatements(),
        ])
          await client.command({
            query: scope(statement),
            clickhouse_settings: { log_queries: 0 },
          });
        for (const [table, columns] of [
          ["activity", "id UUID,user_id UUID"],
          ["sleep_session", "id UUID,user_id UUID"],
          ["processing_operation", "id UUID,user_id UUID"],
          [
            "legacy_bindings",
            "user_id Nullable(UUID),activity_id UUID,group_id Nullable(String),linked_activity_id Nullable(UUID),member_activity_ids Array(Nullable(UUID)),operation_id Nullable(UUID),sleep_session_id Nullable(UUID)",
          ],
        ])
          await client.command({
            query: `CREATE TABLE ${database}.${table} (${columns}) ENGINE=MergeTree ORDER BY tuple()`,
            clickhouse_settings: { log_queries: 0 },
          });
        // Fresh owned tables only; cleanup never supplies the physical proof.
        for (const table of [
          "metric_stream",
          "sensor_scalar_sample",
          "deduped_sensor",
          "activity",
          "sleep_session",
          "processing_operation",
          "legacy_bindings",
        ])
          await client.command({
            query: `ALTER TABLE ${database}.${table} MODIFY SETTING old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
            clickhouse_settings: { log_queries: 0 },
          });
        const bulk = async (offset: number, count: number, owner: string) => {
          const parameters = { owner, first: activity[0], second: activity[1] };
          const input = `SELECT toUUID(concat('70000000-0000-4000-8000-',leftPad(toString(number+1),12,'0'))) AS id,
            if(number%2=0,{first:UUID},{second:UUID}) AS activity_id,{owner:UUID} AS user_id,
            toDateTime64('2026-01-01',6)+toIntervalMicrosecond(number) AS recorded_at,
            'heart_rate' AS channel,'resource' AS provider_id,CAST(NULL,'Nullable(String)') AS external_id,
            CAST(NULL,'Nullable(String)') AS device_id,CAST(NULL,'Nullable(String)') AS source_type,
            toFloat32(70) AS scalar,'{}' AS metadata,toDateTime64('2026-01-02',9) AS ingested_at,
            toInt64(1) AS version,toUInt64(0) AS generation,toInt8(0) AS is_deleted FROM numbers(${offset},${count})`;
          for (const query of [
            `INSERT INTO ${database}.metric_stream (id,activity_id,user_id,recorded_at,channel,provider_id,external_id,device_id,source_type,scalar,metadata,ingested_at,version,generation,is_deleted) ${input}`,
            `INSERT INTO ${database}.sensor_scalar_sample SELECT id,activity_id,activity_id,user_id,recorded_at,toDate(recorded_at),channel,provider_id,external_id,device_id,source_type,'direct',scalar,1,ingested_at,is_deleted,version FROM (${input})`,
            `INSERT INTO ${database}.deduped_sensor SELECT user_id,recorded_at,toDate(recorded_at),channel,scalar,provider_id,activity_id,device_id,external_id,source_type,'direct',id,activity_id,1,toUInt64(1),toUInt8(0),ingested_at FROM (${input})`,
          ]) {
            const queryId = randomUUID();
            seedQueries.push(queryId);
            // Existing synthetic-query evidence policy; production erasure retains log_queries=0.
            await client.command({
              query,
              query_id: queryId,
              query_params: parameters,
              clickhouse_settings: { log_queries: 1, max_threads: 1 },
            });
          }
        };
        // Native bulk fixture load, never intake, migration or historical backfill replay.
        for (let offset = 0; offset < sensorRows; offset += 10000)
          await bulk(offset, Math.min(10000, sensorRows - offset), userId);
        await bulk(sensorRows, 1, survivor);
        for (const table of ["metric_stream", "sensor_scalar_sample", "deduped_sensor"]) {
          expect(
            await queryCount(
              client,
              `SELECT count() AS count FROM ${database}.${table} WHERE user_id={user:UUID}`,
              { user: userId },
            ),
          ).toBe(sensorRows);
          expect(
            await queryCount(
              client,
              `SELECT count() AS count FROM ${database}.${table} WHERE user_id={user:UUID}`,
              { user: survivor },
            ),
          ).toBe(1);
        }
        await physicalPostgres.db.execute(
          sql`INSERT INTO fitness.provider(id,name) VALUES ('erasure-resource','Erasure resource') ON CONFLICT DO NOTHING`,
        );
        await physicalPostgres.db.execute(
          sql`INSERT INTO fitness.user_profile(id,name,email) VALUES (${userId}::uuid,'Resource fixture',${`resource-${userId}@example.test`})`,
        );
        for (const id of activity)
          await physicalPostgres.db.execute(sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at)
          VALUES (${id}::uuid,${userId}::uuid,'erasure-resource',${id},'cycling','cycling',now())`);
        await physicalPostgres.db.execute(
          sql`INSERT INTO fitness.sleep_session(id,user_id,provider_id,started_at) VALUES (${sleep}::uuid,${userId}::uuid,'erasure-resource',now())`,
        );
        for (const id of operation)
          await physicalPostgres.db.execute(
            sql`INSERT INTO fitness.processing_operation(id,user_id,kind,dataset_keys) VALUES (${id}::uuid,${userId}::uuid,'provider_sync',ARRAY['activity'])`,
          );
        if (!client.insert) throw new Error("Resource fixture requires insert");
        for (const [table, ids] of [
          ["activity", activity],
          ["sleep_session", [sleep]],
          ["processing_operation", operation],
        ] as const)
          await client.insert({
            table: `${database}.${table}`,
            values: [
              ...ids.map((id) => ({ id, user_id: userId })),
              { id: randomUUID(), user_id: survivor },
            ],
            format: "JSONEachRow",
            clickhouse_settings: { log_queries: 0 },
          });
        await client.insert({
          table: `${database}.legacy_bindings`,
          values: [
            {
              user_id: null,
              activity_id: activity[0],
              group_id: "Group-A",
              linked_activity_id: activity[1],
              member_activity_ids: [null, activity[1]],
              operation_id: operation[0],
              sleep_session_id: sleep,
            },
            {
              user_id: null,
              activity_id: activity[1],
              group_id: "group-a",
              linked_activity_id: activity[0],
              member_activity_ids: [activity[0]],
              operation_id: operation[1],
              sleep_session_id: sleep,
            },
            {
              user_id: survivor,
              activity_id: activity[0],
              group_id: "Group-A",
              linked_activity_id: activity[1],
              member_activity_ids: [activity[1]],
              operation_id: operation[0],
              sleep_session_id: sleep,
            },
          ],
          format: "JSONEachRow",
          clickhouse_settings: { log_queries: 0 },
        });
        const accepted = await initiateAccountErasure(
          physicalPostgres.db,
          userId,
          (tx) => createEncryptedAccountErasureSnapshot(tx, userId, []),
          async () => undefined,
        );
        const leaseOwner = randomUUID();
        const claimed = await claimAccountErasureRequest(
          physicalPostgres.db,
          accepted.requestId,
          leaseOwner,
          300000,
        );
        if (!claimed?.encryptedRemoteSnapshot)
          throw new Error("Resource activation did not retain its encrypted snapshot");
        const snapshot = await decryptAccountErasureSnapshot(
          claimed.encryptedRemoteSnapshot,
          userId,
        );
        const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
        const credentialLengths = snapshot.appleCredentials.flatMap((value) => [
          value.accessToken.length,
          value.refreshToken?.length ?? 0,
          value.clientId.length,
        ]);
        const store = new AccountErasureIdentifierStore(physicalPostgres.db, {
          requestId: accepted.requestId,
          leaseOwner,
          pageSize: 500,
        });
        const families = async () =>
          z
            .array(z.object({ family: z.string(), count: z.coerce.number().int().nonnegative() }))
            .parse(
              await physicalPostgres.db.execute(sql`
          SELECT family,count(*)::integer AS count FROM fitness.account_erasure_identifier WHERE request_id=${accepted.requestId}::uuid
          AND family IN ('activity','sleep','operation','group_string') GROUP BY family ORDER BY family`),
            );
        const capturedParentCounts = await families();
        const prove = async (stage: "initial" | "final") => {
          expect(await store.loadPhysicalProgress(stage)).toEqual({ step: "complete" });
          expect(
            await queryCount(
              client,
              "SELECT count() AS count FROM system.mutations WHERE database={database:String}",
              { database },
            ),
          ).toBe(0);
          expect(
            await queryCount(
              client,
              "SELECT count() AS count FROM system.detached_parts WHERE database={database:String}",
              { database },
            ),
          ).toBe(0);
          let cursor: string | undefined;
          do {
            const page = await store.readPhysicalPage("physical_part", stage, cursor);
            for (const entry of page.entries)
              for (const [systemTable, column] of [
                ["parts", "name"],
                ["projection_parts", "parent_name"],
              ] as const)
                expect(
                  await queryCount(
                    client,
                    `SELECT count() AS count,min(_state) AS state FROM (SELECT database,table,${column},_state FROM system.${systemTable})
                WHERE database={database:String} AND table={table:String} AND lower(hex(SHA256(${column})))={part_hash:String}`,
                    {
                      database,
                      table: entry.value[2],
                      part_hash: createHash("sha256")
                        .update(Buffer.from(entry.value[4], "base64"))
                        .digest("hex"),
                    },
                  ),
                ).toBe(0);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          for (const table of [
            "metric_stream",
            "sensor_scalar_sample",
            "deduped_sensor",
            "activity",
            "sleep_session",
            "processing_operation",
          ]) {
            expect(
              await queryCount(
                client,
                `SELECT count() AS count FROM ${database}.${table} WHERE user_id={user:UUID}`,
                { user: userId },
              ),
            ).toBe(0);
            expect(
              await queryCount(
                client,
                `SELECT count() AS count FROM ${database}.${table} WHERE user_id={user:UUID}`,
                { user: survivor },
              ),
            ).toBe(1);
          }
          expect(
            await queryCount(
              client,
              `SELECT count() AS count FROM ${database}.legacy_bindings WHERE user_id={user:UUID}`,
              { user: survivor },
            ),
          ).toBe(1);
          expect(
            await queryCount(
              client,
              `SELECT count() AS count FROM ${database}.legacy_bindings WHERE user_id IS NULL`,
            ),
          ).toBe(0);
        };
        await withAnalyticsQueryOwner(
          physicalPostgres.db,
          client,
          { resourceId: `erasure-resource:${accepted.requestId}`, intentId: accepted.requestId },
          async (owner) => {
            await prepareClickHouseAccountErasure(
              owner,
              store,
              { userId, stage: "initial" },
              options,
            );
            const beforeErase = await families();
            expect(beforeErase.filter((value) => value.family !== "group_string")).toEqual(
              capturedParentCounts,
            );
            expect(beforeErase.find((value) => value.family === "group_string")?.count).toBe(2);
            expect(beforeErase.find((value) => value.family === "sleep")?.count).toBe(1);
            expect(beforeErase.find((value) => value.family === "operation")?.count).toBe(2);
            await erasePostgresAccount(physicalPostgres.db, accepted.requestId, userId);
            await executeAccountErasure(owner, store, { userId, stage: "initial" }, options);
            await prove("initial");
            await markAccountErasurePhaseCompleted(
              physicalPostgres.db,
              accepted.requestId,
              leaseOwner,
              "clickhouse_initial",
            );
            // Fixture precondition for the independently tested WAL/mirror boundary; no live CDC/slot claim.
            await markAccountErasurePhaseCompleted(
              physicalPostgres.db,
              accepted.requestId,
              leaseOwner,
              "peerdb_drain_verification",
              { fixturePrecondition: "independently-qualified-peerdb-boundary" },
            );
            await prepareClickHouseAccountErasure(
              owner,
              store,
              { userId, stage: "final" },
              options,
            );
            await executeAccountErasure(owner, store, { userId, stage: "final" }, options);
            await prove("final");
            expect(await families()).toEqual(beforeErase);
            comparisons.push({ families: beforeErase, snapshotBytes, credentialLengths });
            if (comparisons.length === 2) expect(comparisons[1]).toEqual(comparisons[0]);
          },
        );
        await client.command({
          query: "SYSTEM FLUSH LOGS",
          clickhouse_settings: { log_queries: 0 },
        });
        const measured = z
          .tuple([z.object({ logged: z.coerce.number(), memory: z.coerce.number() })])
          .parse(
            await (
              await client.query({
                query:
                  "SELECT countIf(type='QueryFinish') AS logged,maxIf(memory_usage,type='QueryFinish') AS memory FROM system.query_log WHERE query_id IN {ids:Array(String)}",
                query_params: { ids: seedQueries },
                format: "JSONEachRow",
                clickhouse_settings: { log_queries: 0 },
              })
            ).json(),
          )[0];
        if (measured.logged > 0) expect(measured.memory).toBeLessThanOrEqual(queryMemoryLimitBytes);
        logger.info(
          JSON.stringify({
            erasureResource: {
              sensorRows,
              ...comparisons.at(-1),
              queryLimitBytes: queryMemoryLimitBytes,
              loggedSeedQueries: measured.logged,
              seedQueryCount: seedQueries.length,
              measuredSeedPeakBytes: measured.logged ? measured.memory : null,
              erasurePeakBytes: null,
            },
          }),
        );
        // All semantic, survivor, all-state and metadata0 assertions precede owned-DB cleanup.
      } finally {
        await cleanFences(client, userId, operation);
        await dropDatabase(client, database);
      }
    }
    expect(comparisons).toHaveLength(2);
    expect(comparisons[1]).toEqual(comparisons[0]);
  }, 180_000);

  it("bounds worst-case String identifier capture", async () => {
    const database = databaseName("account_erasure_string_budget");
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.account_rows (user_id UUID,group_id String)
          ENGINE=MergeTree ORDER BY user_id
          SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,
            cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
        clickhouse_settings: { log_queries: 0 },
      });
      // Generate payloads in the engine without assembling a whole-account Node array.
      for (let offset = 0; offset < 500; offset += 10) {
        await client.command({
          query: `INSERT INTO ${database}.account_rows
            SELECT {user_id:UUID},concat(leftPad(toString(number+{offset:UInt64}),8,'0'),repeat('x',4096-8))
            FROM numbers(10)`,
          query_params: { user_id: userId, offset },
          clickhouse_settings: { log_queries: 0 },
        });
      }
      const capture: Parameters<typeof readClickHouseErasureIdentifierPage>[1] = {
        table: {
          database,
          name: "account_rows",
          engine: "MergeTree",
          uuid: randomUUID(),
          age_milliseconds: 0,
          columns: [
            ["user_id", "UUID"],
            ["group_id", "String"],
          ],
        },
        column: [
          "group_id",
          { family: "stringRelationIds", valueType: "string", cardinality: "scalar" },
        ] as const,
        predicate: { sql: "user_id={user_id:UUID}", queryParameters: { user_id: userId } },
      };
      const prefixes: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await readClickHouseErasureIdentifierPage(client, {
          ...capture,
          after: cursor,
        });
        expect(
          page.values.reduce((sum, value) => sum + Buffer.from(value, "base64").length, 0),
        ).toBeLessThanOrEqual(256 * 1024);
        expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(1024 * 1024);
        prefixes.push(
          ...page.values.map((value) => Buffer.from(value, "base64").subarray(0, 8).toString()),
        );
        if (page.nextCursor) expect(page.nextCursor).toHaveLength(5464);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(prefixes).toEqual(
        Array.from({ length: 500 }, (_, index) => index.toString().padStart(8, "0")),
      );
    } finally {
      await dropDatabase(client, database);
      await cleanFences(client, userId, []);
    }
  }, 120_000);

  it("pages exact-byte String groups through duplicate boundaries and NULL values", async () => {
    const database = databaseName("account_erasure_string_bytes");
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.account_rows (user_id UUID,group_id Nullable(String)) ENGINE=MergeTree ORDER BY user_id`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${database}.account_rows VALUES
        ({user_id:UUID},NULL),({user_id:UUID},'A'),({user_id:UUID},'A'),({user_id:UUID},'a'),({user_id:UUID},unhex('00ff8041'))`,
        query_params: { user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${database}.account_rows SELECT {user_id:UUID},'A' FROM numbers(1000)`,
        query_params: { user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      const capture: Parameters<typeof readClickHouseErasureIdentifierPage>[1] = {
        table: {
          database,
          name: "account_rows",
          engine: "MergeTree",
          uuid: randomUUID(),
          age_milliseconds: 0,
          columns: [
            ["user_id", "UUID"],
            ["group_id", "Nullable(String)"],
          ],
        },
        column: [
          "group_id",
          { family: "stringRelationIds", valueType: "string", cardinality: "scalar" },
        ],
        predicate: { sql: "user_id={user_id:UUID}", queryParameters: { user_id: userId } },
      };
      const first = await readClickHouseErasureIdentifierPage(client, capture);
      const second = await readClickHouseErasureIdentifierPage(client, {
        ...capture,
        after: first.nextCursor ?? undefined,
      });
      expect([
        ...new Set(first.values.map((value) => Buffer.from(value, "base64").toString("hex"))),
      ]).toEqual(["00ff8041", "41"]);
      expect(second.values.map((value) => Buffer.from(value, "base64").toString("hex"))).toEqual([
        "61",
      ]);
      expect(second.nextCursor).toBeNull();
      await client.command({
        query: `INSERT INTO ${database}.account_rows SELECT {user_id:UUID},repeat('x',4097)`,
        query_params: { user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await expect(readClickHouseErasureIdentifierPage(client, capture)).rejects.toMatchObject({
        name: "AccountErasureIdentifierBudgetError",
        message: expect.stringMatching(/identifier.*4 KiB.*Contact support/),
      });
      await expect(
        readClickHouseErasureIdentifierPage(client, { ...capture, after: "A".repeat(5468) }),
      ).rejects.toThrow(/cursor.*4 KiB/);
    } finally {
      await dropDatabase(client, database);
    }
  });

  it("restarts bounded cyclic identity closure from the start and seals only a complete no-insert pass", async () => {
    const postgres = await setupTestDatabase();
    const database = databaseName("account_erasure_closure");
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const firstId = randomUUID();
    const nextId = randomUUID();
    const lastId = randomUUID();
    const otherId = randomUUID();
    const leaseOwner = "closure-fixture-worker";
    await createDatabase(client, database);
    try {
      await postgres.db.execute(
        sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId}::uuid,'Closure fixture')`,
      );
      const accepted = await initiateAccountErasure(
        postgres.db,
        userId,
        async () => "bounded-snapshot-fixture",
        async () => undefined,
      );
      await claimAccountErasureRequest(postgres.db, accepted.requestId, leaseOwner, 300000);
      const store = new AccountErasureIdentifierStore(postgres.db, {
        requestId: accepted.requestId,
        pageSize: 500,
        leaseOwner,
      });
      for (const [name, columns] of [
        ["activity", "id UUID,user_id UUID"],
        ["bridge", "activity_id UUID,group_id String"],
        [
          "nullable_bridge",
          "user_id Nullable(UUID),group_id Nullable(String),linked_activity_id UUID",
        ],
        ["cycle", "source_activity_id UUID,linked_activity_id UUID"],
      ]) {
        await client.command({
          query: `CREATE TABLE ${database}.${name} (${columns}) ENGINE=MergeTree ORDER BY tuple()`,
          clickhouse_settings: { log_queries: 0 },
        });
      }
      await client.command({
        query: `INSERT INTO ${database}.activity VALUES ({first:UUID},{user:UUID})`,
        query_params: { first: firstId, user: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${database}.bridge VALUES ({first:UUID},unhex('0041ff'))`,
        query_params: { first: firstId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${database}.nullable_bridge VALUES (NULL,unhex('0041ff'),{next:UUID}),({other:UUID},unhex('0041ff'),{excluded:UUID})`,
        query_params: { next: nextId, other: otherUserId, excluded: otherId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${database}.cycle VALUES ({next:UUID},{last:UUID}),({last:UUID},{first:UUID})`,
        query_params: { next: nextId, last: lastId, first: firstId },
        clickhouse_settings: { log_queries: 0 },
      });
      await withAnalyticsQueryOwner(
        postgres.db,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: `account-erasure:${accepted.requestId}:prepare`,
        },
        async (owner) => {
          let checks = 0;
          const interruptedOwner = {
            ...owner,
            assertActive: async () => {
              await owner.assertActive();
              checks += 1;
              if (checks === 3)
                throw new Error("synthetic interruption after a committed capture page");
            },
          };
          await expect(
            prepareClickHouseAccountErasureIdentifiers(
              interruptedOwner,
              store,
              { userId, stage: "initial" },
              { managedDatabases: [database] },
            ),
          ).rejects.toThrow("synthetic interruption");
          await expect(store.assertClosureComplete("initial")).rejects.toThrow(/incomplete/);
          expect(await store.findPresent("activity", [firstId])).toEqual([firstId]);
          await prepareClickHouseAccountErasureIdentifiers(
            owner,
            store,
            { userId, stage: "initial" },
            { managedDatabases: [database] },
          );
          await expect(store.assertClosureComplete("initial")).resolves.toBeUndefined();
          expect(
            (await store.findPresent("activity", [firstId, nextId, lastId, otherId])).sort(),
          ).toEqual([firstId, nextId, lastId].sort());
          expect(
            await store.findPresent("group_string", [Buffer.from([0, 65, 255]).toString("base64")]),
          ).toEqual([Buffer.from([0, 65, 255]).toString("base64")]);
        },
      );
    } finally {
      await dropDatabase(client, database);
      await postgres.cleanup();
    }
  }, 120000);

  it("honors explicit nullable ownership before a colliding user_profile identity", async () => {
    const postgres = await setupTestDatabase();
    const database = databaseName("account_erasure_profile_owner");
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const ownedActivity = randomUUID();
    const excludedActivity = randomUUID();
    const leaseOwner = "profile-owner-fixture";
    await createDatabase(client, database);
    try {
      await postgres.db.execute(
        sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId}::uuid,'Profile owner fixture')`,
      );
      const accepted = await initiateAccountErasure(
        postgres.db,
        userId,
        async () => "bounded-snapshot-fixture",
        async () => undefined,
      );
      await claimAccountErasureRequest(postgres.db, accepted.requestId, leaseOwner, 300000);
      const store = new AccountErasureIdentifierStore(postgres.db, {
        requestId: accepted.requestId,
        pageSize: 500,
        leaseOwner,
      });
      await client.command({
        query: `CREATE TABLE ${database}.user_profile (id UUID,user_id Nullable(UUID),activity_id UUID) ENGINE=MergeTree ORDER BY id`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${database}.user_profile VALUES
        ({user:UUID},{other:UUID},{excluded:UUID}),
        (generateUUIDv4(),{user:UUID},{owned:UUID}),
        (generateUUIDv4(),NULL,{owned:UUID})`,
        query_params: {
          user: userId,
          other: otherUserId,
          excluded: excludedActivity,
          owned: ownedActivity,
        },
        clickhouse_settings: { log_queries: 0 },
      });
      await withAnalyticsQueryOwner(
        postgres.db,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: `account-erasure:${accepted.requestId}:prepare`,
        },
        (owner) =>
          prepareClickHouseAccountErasureIdentifiers(
            owner,
            store,
            { userId, stage: "initial" },
            { managedDatabases: [database] },
          ),
      );
      expect(await store.findPresent("activity", [ownedActivity, excludedActivity])).toEqual([
        ownedActivity,
      ]);
      await expect(store.assertClosureComplete("initial")).resolves.toBeUndefined();
    } finally {
      await dropDatabase(client, database);
      await postgres.cleanup();
    }
  }, 120000);

  it("typed ownership coverage accepts the current production bootstrap schemas", async () => {
    await inspectClickHouseAccountErasureCoverage(client);
  });

  it("typed ownership coverage allows a fresh matched stage at startup and blocks its erasure", async () => {
    const database = databaseName("account_erasure_startup");
    const stage = `daily_sleep__dbt_new_data_${randomUUID().replaceAll("-", "_")}`;
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      for (const name of ["daily_sleep", stage]) {
        await client.command({
          query: `CREATE TABLE ${database}.${name} (user_id UUID,value String) ENGINE=MergeTree ORDER BY user_id`,
        });
      }
      await inspectClickHouseAccountErasureCoverage(client, { managedDatabases: [database] });
      await expect(
        eraseClickHouseAccount(
          client,
          { userId, activityIds: [], sleepSessionIds: [], operationIds: [] },
          { managedDatabases: [database], orphanStagingMinimumAgeMilliseconds: 3600000 },
        ),
      ).rejects.toThrow("active dbt staging table");
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120_000);

  it.each([
    "daily_sleep__dbt_new_data_invalid",
    `daily_sleep__dbt_new_data_${randomUUID().replaceAll("-", "_")}`,
  ])(
    "typed ownership coverage rejects malformed or unmatched staging tables at startup: %s",
    async (stage) => {
      const database = databaseName("account_erasure_stage");
      await createDatabase(client, database);
      try {
        await client.command({
          query: `CREATE TABLE ${database}.${stage} (user_id UUID) ENGINE=MergeTree ORDER BY user_id`,
        });
        await expect(
          inspectClickHouseAccountErasureCoverage(client, { managedDatabases: [database] }),
        ).rejects.toThrow(/dbt staging/);
      } finally {
        await dropDatabase(client, database);
      }
    },
    120_000,
  );

  it("typed ownership coverage rejects a staging sensor identity type that differs from its canonical table", async () => {
    const database = databaseName("account_erasure_stage_type");
    const stage = `sensor_scalar_sample__dbt_new_data_${randomUUID().replaceAll("-", "_")}`;
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.sensor_scalar_sample (user_id UUID,id UUID) ENGINE=MergeTree ORDER BY user_id`,
      });
      await client.command({
        query: `CREATE TABLE ${database}.${stage} (user_id UUID,id String) ENGINE=MergeTree ORDER BY user_id`,
      });
      await expect(
        inspectClickHouseAccountErasureCoverage(client, { managedDatabases: [database] }),
      ).rejects.toThrow("staging schema mismatch");
    } finally {
      await dropDatabase(client, database);
    }
  }, 120_000);

  it.each([
    "id UUID",
    "measurement_id UUID",
    "panel_id Nullable(UUID)",
    "metric_stream_id UUID",
    "source_metric_stream_id UUID",
    "user_id Nullable(UUID), id UUID",
  ])(
    "typed ownership coverage rejects an unknown physical domain before deleting account rows: %s",
    async (columns) => {
      const database = databaseName("account_erasure_coverage");
      const userId = randomUUID();
      await createDatabase(client, database);
      try {
        await client.command({
          query: `CREATE TABLE ${database}.known_rows (user_id UUID, value String) ENGINE=MergeTree ORDER BY user_id SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
        });
        await client.command({
          query: `CREATE TABLE ${database}.unknown_rows (${columns}) ENGINE=MergeTree ORDER BY tuple()`,
        });
        if (!client.insert)
          throw new Error("ClickHouse integration client requires insert support");
        await client.insert({
          table: `${database}.known_rows`,
          values: [{ user_id: userId, value: "must-remain" }],
          format: "JSONEachRow",
        });
        await expect(
          eraseClickHouseAccount(
            client,
            { userId, activityIds: [], sleepSessionIds: [], operationIds: [] },
            {
              managedDatabases: [database],
              physicalPartPollIntervalMilliseconds: 1000,
              physicalPartWaitTimeoutMilliseconds: 45000,
            },
          ),
        ).rejects.toThrow(/ownership|record|unclassified/i);
        expect(await tableValues(client, database, "known_rows")).toEqual(["must-remain"]);
      } finally {
        await cleanFences(client, userId, []);
        await dropDatabase(client, database);
      }
    },
    120_000,
  );

  it("typed ownership coverage rejects personal columns added to a protected shared fence", async () => {
    const userId = randomUUID();
    await client.command({
      query: `ALTER TABLE ${ACCOUNT_ERASURE_FENCE_TABLE} ADD COLUMN email String DEFAULT ''`,
    });
    try {
      await expect(
        eraseClickHouseAccount(
          client,
          { userId, activityIds: [], sleepSessionIds: [], operationIds: [] },
          { managedDatabases: ["ingest"] },
        ),
      ).rejects.toThrow(/email/);
    } finally {
      await client.command({
        query: `ALTER TABLE ${ACCOUNT_ERASURE_FENCE_TABLE} DROP COLUMN email`,
      });
      await cleanFences(client, userId, []);
    }
  }, 120_000);

  it("typed ownership coverage keeps an unrelated sleep-stage identity that collides with a sensor row UUID", async () => {
    const database = databaseName("account_erasure_domains");
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const sensorId = randomUUID();
    const sessionId = randomUUID();
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.metric_stream (id UUID,user_id UUID,value String) ENGINE=MergeTree ORDER BY id SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
      });
      await client.command({
        query: `CREATE TABLE ${database}.sleep_session (id UUID,user_id UUID,value String) ENGINE=MergeTree ORDER BY id SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
      });
      await client.command({
        query: `CREATE TABLE ${database}.sleep_stage (id UUID,session_id UUID,value String) ENGINE=MergeTree ORDER BY id SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
      });
      if (!client.insert) throw new Error("ClickHouse integration client requires insert support");
      await client.insert({
        table: `${database}.metric_stream`,
        values: [
          { id: sensorId, user_id: userId, value: "delete" },
          { id: randomUUID(), user_id: otherUserId, value: "keep" },
        ],
        format: "JSONEachRow",
      });
      await client.insert({
        table: `${database}.sleep_session`,
        values: [{ id: sessionId, user_id: userId, value: "delete" }],
        format: "JSONEachRow",
      });
      await client.insert({
        table: `${database}.sleep_stage`,
        values: [
          { id: randomUUID(), session_id: sessionId, value: "delete" },
          { id: sensorId, session_id: randomUUID(), value: "keep-other-domain" },
        ],
        format: "JSONEachRow",
      });
      await eraseClickHouseAccount(
        client,
        { userId, activityIds: [], sleepSessionIds: [], operationIds: [] },
        {
          managedDatabases: [database],
          physicalPartPollIntervalMilliseconds: 1000,
          physicalPartWaitTimeoutMilliseconds: 45000,
        },
      );
      expect(await tableValues(client, database, "metric_stream")).toEqual(["keep"]);
      expect(await tableValues(client, database, "sleep_stage")).toEqual(["keep-other-domain"]);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120_000);

  it("erases UUID group and source-activity relations alongside legacy string groups without crossing families", async () => {
    const database = databaseName("account_erasure_groups");
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const activityId = randomUUID();
    const otherActivityId = randomUUID();
    const groupId = randomUUID();
    const otherGroupId = randomUUID();
    const staging = `deduped_sensor__dbt_new_data_${randomUUID().replaceAll("-", "_")}`;
    const tables = [
      {
        name: "activity",
        columns: "id UUID, user_id UUID, group_id Nullable(UUID)",
        rows: [
          { id: activityId, user_id: userId, group_id: groupId, value: "delete" },
          { id: otherActivityId, user_id: otherUserId, group_id: otherGroupId, value: "keep" },
        ],
      },
      {
        name: "activity_source_records",
        columns: "activity_id UUID, group_id UUID",
        rows: [
          { activity_id: activityId, group_id: groupId, value: "delete" },
          { activity_id: otherActivityId, group_id: otherGroupId, value: "keep" },
        ],
      },
      {
        name: "uuid_group_rows",
        columns: "group_id UUID",
        rows: [
          { group_id: groupId, value: "delete" },
          { group_id: otherGroupId, value: "keep" },
        ],
      },
      ...["deduped_sensor", staging].map((name) => ({
        name,
        columns: "source_activity_id Nullable(UUID)",
        rows: [
          { source_activity_id: activityId, value: "delete" },
          { source_activity_id: otherActivityId, value: "keep" },
          { source_activity_id: null, value: "keep-unlinked" },
        ],
      })),
      {
        name: "nullable_members",
        columns: "user_id Nullable(UUID), member_activity_ids Array(Nullable(UUID))",
        rows: [
          { user_id: null, member_activity_ids: [activityId, null], value: "delete" },
          { user_id: userId, member_activity_ids: [activityId], value: "delete-direct" },
          { user_id: otherUserId, member_activity_ids: [activityId], value: "keep-explicit-owner" },
          {
            user_id: null,
            member_activity_ids: [null, otherActivityId],
            value: "keep-other-array",
          },
          { user_id: null, member_activity_ids: [], value: "keep-empty" },
        ],
      },
      {
        name: "legacy_members",
        columns: "activity_id UUID, group_id LowCardinality(String)",
        rows: [
          { activity_id: activityId, group_id: "legacy-delete", value: "delete" },
          { activity_id: otherActivityId, group_id: "legacy-keep", value: "keep" },
        ],
      },
      {
        name: "legacy_groups",
        columns: "group_id Nullable(String)",
        rows: [
          { group_id: "legacy-delete", value: "delete" },
          { group_id: "legacy-keep", value: "keep" },
          { group_id: groupId, value: "keep-string-uuid" },
        ],
      },
    ];
    await createDatabase(client, database);
    try {
      if (!client.insert) throw new Error("ClickHouse integration client requires insert support");
      for (const table of tables) {
        await client.command({
          query: `CREATE TABLE \`${database}\`.\`${table.name}\` (${table.columns}, value String)
          ENGINE = MergeTree ORDER BY tuple()
          SETTINGS old_parts_lifetime = 1, cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0, max_cleanup_delay_period = 1`,
          clickhouse_settings: { log_queries: 0 },
        });
        await client.insert({
          table: `${database}.${table.name}`,
          values: table.rows,
          format: "JSONEachRow",
          clickhouse_settings: { log_queries: 0 },
        });
      }
      await eraseClickHouseAccount(
        client,
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
        {
          managedDatabases: [database],
          orphanStagingMinimumAgeMilliseconds: 0,
          physicalPartPollIntervalMilliseconds: 1_000,
          physicalPartWaitTimeoutMilliseconds: 45_000,
        },
      );
      for (const name of [
        "activity",
        "activity_source_records",
        "uuid_group_rows",
        "legacy_members",
      ]) {
        await expect(tableValues(client, database, name)).resolves.toEqual(["keep"]);
      }
      for (const name of ["deduped_sensor", staging]) {
        await expect(tableValues(client, database, name)).resolves.toEqual([
          "keep",
          "keep-unlinked",
        ]);
      }
      expect(await tableValues(client, database, "nullable_members")).toEqual([
        "keep-empty",
        "keep-explicit-owner",
        "keep-other-array",
      ]);
      await expect(tableValues(client, database, "legacy_groups")).resolves.toEqual([
        "keep",
        "keep-string-uuid",
      ]);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120_000);

  it("erases current provider and heart-rate read models while preserving the other account", async () => {
    const managedDatabase = databaseName("account_erasure_read_models");
    await createDatabase(client, managedDatabase);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const sleepId = randomUUID();
    const otherSleepId = randomUUID();

    await client.command({
      query: `CREATE TABLE IF NOT EXISTS ${managedDatabase}.provider_change_state (
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
      query: `CREATE TABLE IF NOT EXISTS ${managedDatabase}.heart_rate_day_change (
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
      query: `CREATE TABLE IF NOT EXISTS ${managedDatabase}.sleep_heart_rate_window (
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
        query: `INSERT INTO ${managedDatabase}.provider_change_state
            (user_id, provider_id, changed_at)
          VALUES
            ({user_id:UUID}, 'garmin', now64(9)),
            ({other_user_id:UUID}, 'garmin', now64(9))`,
        query_params: { other_user_id: otherUserId, user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${managedDatabase}.heart_rate_day_change
            (user_id, recorded_date, changed_at)
          VALUES
            ({user_id:UUID}, today(), now64(9)),
            ({other_user_id:UUID}, today(), now64(9))`,
        query_params: { other_user_id: otherUserId, user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `INSERT INTO ${managedDatabase}.sleep_heart_rate_window (
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

      await eraseClickHouseAccount(
        client,
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [sleepId],
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
          `SELECT count() AS count FROM ${managedDatabase}.provider_change_state WHERE user_id = {user_id:UUID}`,
          { user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          `SELECT count() AS count FROM ${managedDatabase}.heart_rate_day_change WHERE user_id = {user_id:UUID}`,
          { user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          `SELECT count() AS count FROM ${managedDatabase}.sleep_heart_rate_window WHERE user_id = {user_id:UUID}`,
          { user_id: userId },
        ),
      ).resolves.toBe(0);
      await expect(
        queryCount(
          client,
          `SELECT count() AS count FROM ${managedDatabase}.sleep_heart_rate_window WHERE user_id = {user_id:UUID}`,
          { user_id: otherUserId },
        ),
      ).resolves.toBe(1);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, managedDatabase);
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
        query: `CREATE TABLE \`${managedDatabase}\`.sleep_stage (
          id UUID,
          session_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY (session_id,id)
        SETTINGS
          old_parts_lifetime = 1,
          cleanup_delay_period = 1,
          cleanup_delay_period_random_add = 0,
          max_cleanup_delay_period = 1`,
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `CREATE TABLE \`${managedDatabase}\`.processing_flow_marker (
          id UUID,
          operation_id UUID,
          value String
        ) ENGINE = MergeTree
        ORDER BY (operation_id,id)
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
        table: `${managedDatabase}.sleep_stage`,
        values: [
          { id: randomUUID(), session_id: sleepSessionId, value: "delete-sleep" },
          { id: randomUUID(), session_id: otherSleepSessionId, value: "keep-other-sleep" },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${managedDatabase}.processing_flow_marker`,
        values: [
          { id: randomUUID(), operation_id: operationId, value: "delete-processing" },
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
      await expect(tableValues(client, managedDatabase, "sleep_stage")).resolves.toEqual([
        "keep-other-sleep",
      ]);
      await expect(tableValues(client, managedDatabase, "processing_flow_marker")).resolves.toEqual(
        ["keep-other-processing"],
      );
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

  it("follows exact physical UUID history across a pre-seal table rename", async () => {
    const database = databaseName("account_erasure_rename");
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.old_rows (user_id UUID,value String) ENGINE=MergeTree ORDER BY user_id
        SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) throw new Error("Fixture requires insert");
      await client.insert({
        table: `${database}.old_rows`,
        values: [
          { user_id: userId, value: "delete" },
          { user_id: randomUUID(), value: "keep" },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({ query: "SYSTEM FLUSH LOGS", clickhouse_settings: { log_queries: 0 } });
      const before = await inspectClickHouseAccountErasureCoverage(client, {
        managedDatabases: [database],
      });
      await client.command({
        query: `RENAME TABLE ${database}.old_rows TO ${database}.account_rows`,
        clickhouse_settings: { log_queries: 0 },
      });
      const after = await inspectClickHouseAccountErasureCoverage(client, {
        managedDatabases: [database],
      });
      expect(after[0]?.uuid).toBe(before[0]?.uuid);
      await eraseClickHouseAccount(
        client,
        { userId, activityIds: [], operationIds: [], sleepSessionIds: [] },
        {
          managedDatabases: [database],
          physicalPartPollIntervalMilliseconds: 25,
          physicalPartWaitTimeoutMilliseconds: 45000,
        },
      );
      expect(await tableValues(client, database, "account_rows")).toEqual(["keep"]);
      expect(
        await queryCount(
          client,
          "SELECT count() AS count FROM system.mutations WHERE database={database:String}",
          { database },
        ),
      ).toBe(0);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120000);

  it.each(["before KILL", "after KILL"] as const)(
    "resumes durable physical cleanup after a crash %s",
    async (boundary) => {
      const database = databaseName("account_erasure_crash");
      const userId = randomUUID();
      class CrashStore extends AccountErasureIdentifierStore {
        override async markPhysicalComplete(stage: "initial" | "final") {
          await super.markPhysicalComplete(stage);
          if (boundary === "before KILL") throw new Error("crash before KILL");
        }
        override async retirePhysicalMutation(
          stage: "initial" | "final",
          input: { key: string; expectedAfterKey: string | null },
        ) {
          if (boundary === "after KILL") throw new Error("crash after KILL");
          await super.retirePhysicalMutation(stage, input);
        }
      }
      await createDatabase(client, database);
      try {
        await client.command({
          query: `CREATE TABLE ${database}.account_rows (user_id UUID,value String) ENGINE=MergeTree ORDER BY user_id
        SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
          clickhouse_settings: { log_queries: 0 },
        });
        if (!client.insert) throw new Error("Fixture requires insert");
        await client.insert({
          table: `${database}.account_rows`,
          values: [
            { user_id: userId, value: "delete" },
            { user_id: randomUUID(), value: "keep" },
          ],
          format: "JSONEachRow",
          clickhouse_settings: { log_queries: 0 },
        });
        const fixture = await physicalFixture(userId, CrashStore);
        const options = {
          managedDatabases: [database],
          physicalPartPollIntervalMilliseconds: 25,
          physicalPartWaitTimeoutMilliseconds: 45000,
        };
        await fixture.run((owner) =>
          prepareClickHouseAccountErasure(owner, fixture.store, fixture.input, options),
        );
        await expect(
          fixture.run((owner) =>
            executeAccountErasure(owner, fixture.store, fixture.input, options),
          ),
        ).rejects.toThrow(`crash ${boundary}`);
        expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({
          step: "cleanup",
          afterMutationKey: null,
        });
        expect(
          (await fixture.store.readPhysicalPage("physical_mutation", "initial")).entries,
        ).toHaveLength(1);
        expect(
          await queryCount(
            client,
            "SELECT count() AS count FROM system.mutations WHERE database={database:String}",
            { database },
          ),
        ).toBe(boundary === "before KILL" ? 1 : 0);
        const recovered = new AccountErasureIdentifierStore(physicalPostgres.db, {
          requestId: fixture.requestId,
          leaseOwner: fixture.leaseOwner,
          pageSize: 500,
        });
        await fixture.run((owner) =>
          executeAccountErasure(owner, recovered, fixture.input, options),
        );
        expect(await recovered.loadPhysicalProgress("initial")).toEqual({ step: "complete" });
        expect(
          (await recovered.readPhysicalPage("physical_mutation", "initial")).entries,
        ).toHaveLength(0);
        expect(
          await queryCount(
            client,
            "SELECT count() AS count FROM system.mutations WHERE database={database:String}",
            { database },
          ),
        ).toBe(0);
        expect(await tableValues(client, database, "account_rows")).toEqual(["keep"]);
      } finally {
        await cleanFences(client, userId, []);
        await dropDatabase(client, database);
      }
    },
    120000,
  );

  it.each(["new classified table", "column change", "table UUID replacement"] as const)(
    "rejects a frozen physical plan after %s",
    async (drift) => {
      const database = databaseName("account_erasure_schema");
      const userId = randomUUID();
      await createDatabase(client, database);
      try {
        const ddl = `CREATE TABLE ${database}.account_rows (user_id UUID,value String) ENGINE=MergeTree ORDER BY user_id`;
        await client.command({ query: ddl, clickhouse_settings: { log_queries: 0 } });
        const fixture = await physicalFixture(userId);
        const options = { managedDatabases: [database] };
        await fixture.run((owner) =>
          prepareClickHouseAccountErasure(owner, fixture.store, fixture.input, options),
        );
        if (drift === "new classified table")
          await client.command({
            query: `CREATE TABLE ${database}.new_rows (user_id UUID) ENGINE=MergeTree ORDER BY user_id`,
            clickhouse_settings: { log_queries: 0 },
          });
        else if (drift === "column change")
          await client.command({
            query: `ALTER TABLE ${database}.account_rows ADD COLUMN extra UInt8`,
            clickhouse_settings: { log_queries: 0 },
          });
        else {
          await client.command({
            query: `DROP TABLE ${database}.account_rows SYNC`,
            clickhouse_settings: { log_queries: 0 },
          });
          await client.command({ query: ddl, clickhouse_settings: { log_queries: 0 } });
        }
        await expect(
          fixture.run((owner) =>
            executeAccountErasure(owner, fixture.store, fixture.input, options),
          ),
        ).rejects.toThrow("schema changed");
        expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({
          step: "apply",
          afterIntentKey: null,
          pending: null,
        });
      } finally {
        await cleanFences(client, userId, []);
        await dropDatabase(client, database);
      }
    },
    120000,
  );

  it("applies disjoint predicate pages before proving their shared and intermediate parts", async () => {
    const database = databaseName("account_erasure_disjoint");
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      for (const [name, columns] of [
        ["account_rows", "user_id UUID,group_id String"],
        ["activity_duplicate_groups", "group_id Nullable(String),value String"],
      ])
        await client.command({
          query: `CREATE TABLE ${database}.${name} (${columns}) ENGINE=MergeTree ORDER BY tuple()
          SETTINGS old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
          clickhouse_settings: { log_queries: 0 },
        });
      await client.command({
        query: `INSERT INTO ${database}.account_rows SELECT {user_id:UUID},toString(number) FROM numbers(65)`,
        query_params: { user_id: userId },
        clickhouse_settings: { log_queries: 0 },
      });
      const fixture = await physicalFixture(userId);
      const options = {
        managedDatabases: [database],
        physicalPartPollIntervalMilliseconds: 25,
        physicalPartWaitTimeoutMilliseconds: 45000,
      };
      await fixture.run((owner) =>
        prepareClickHouseAccountErasureIdentifiers(owner, fixture.store, fixture.input, options),
      );
      const first = await fixture.store.readPage("group_string");
      if (!first.nextCursor) throw new Error("Fixture must span String pages");
      const second = await fixture.store.readPage("group_string", first.nextCursor);
      const one = first.entries[0]?.value;
      const two = second.entries[0]?.value;
      if (!one || !two) throw new Error("Missing disjoint predicate fixtures");
      await client.command({
        query: `SYSTEM STOP MERGES ${database}.activity_duplicate_groups`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) throw new Error("Fixture requires insert");
      await client.insert({
        table: `${database}.activity_duplicate_groups`,
        values: [
          { group_id: Buffer.from(one, "base64").toString(), value: "shared-one" },
          { group_id: Buffer.from(two, "base64").toString(), value: "shared-two" },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${database}.activity_duplicate_groups`,
        values: first.entries.slice(1).map((entry) => ({
          group_id: Buffer.from(entry.value, "base64").toString(),
          value: "disjoint",
        })),
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.insert({
        table: `${database}.activity_duplicate_groups`,
        values: [{ group_id: "unrelated", value: "keep" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await fixture.run((owner) =>
        prepareClickHouseAccountErasure(owner, fixture.store, fixture.input, options),
      );
      const intents = (await fixture.store.readPhysicalPage("physical_intent", "initial")).entries;
      expect(
        intents.filter((entry) => entry.value[2] === "activity_duplicate_groups"),
      ).toHaveLength(2);
      await client.command({
        query: `SYSTEM START MERGES ${database}.activity_duplicate_groups`,
        clickhouse_settings: { log_queries: 0 },
      });
      await fixture.run((owner) =>
        executeAccountErasure(owner, fixture.store, fixture.input, options),
      );
      expect(await tableValues(client, database, "activity_duplicate_groups")).toEqual(["keep"]);
      expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({ step: "complete" });
      expect(
        await queryCount(
          client,
          "SELECT count() AS count FROM system.mutations WHERE database={database:String}",
          { database },
        ),
      ).toBe(0);
      expect(
        (await fixture.store.readPhysicalPage("physical_part", "initial")).entries.length,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120000);

  it("retains inactive projection parents in the all-state physical proof", async () => {
    const database = databaseName("account_erasure_projection");
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.account_rows (user_id UUID,value String,
        PROJECTION by_value (SELECT user_id,value ORDER BY value)) ENGINE=MergeTree ORDER BY user_id SETTINGS old_parts_lifetime=3600`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) throw new Error("Fixture requires insert");
      await client.insert({
        table: `${database}.account_rows`,
        values: [
          { user_id: userId, value: "delete" },
          { user_id: randomUUID(), value: "keep" },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      expect(
        await queryCount(
          client,
          `SELECT count() AS count FROM (SELECT database,table,_state FROM system.projection_parts) WHERE database={database:String} AND _state='Active'`,
          { database },
        ),
      ).toBeGreaterThan(0);
      await expect(
        eraseClickHouseAccount(
          client,
          { userId, activityIds: [], operationIds: [], sleepSessionIds: [] },
          {
            managedDatabases: [database],
            physicalPartPollIntervalMilliseconds: 25,
            physicalPartWaitTimeoutMilliseconds: 100,
          },
        ),
      ).rejects.toThrow("timed out");
      expect(
        await queryCount(
          client,
          `SELECT count() AS count FROM (SELECT database,table,_state FROM system.projection_parts) WHERE database={database:String} AND _state!='Active'`,
          { database },
        ),
      ).toBeGreaterThan(0);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120000);

  it("refuses a newly detached target table even when its frozen predicate plan is empty", async () => {
    const database = databaseName("account_erasure_empty_detached");
    const userId = randomUUID();
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.activity_rows (activity_id UUID,value String) ENGINE=MergeTree ORDER BY activity_id`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) throw new Error("Fixture requires insert");
      await client.insert({
        table: `${database}.activity_rows`,
        values: [{ activity_id: randomUUID(), value: "unrelated" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      const fixture = await physicalFixture(userId);
      const options = { managedDatabases: [database] };
      await fixture.run((owner) =>
        prepareClickHouseAccountErasure(owner, fixture.store, fixture.input, options),
      );
      const parts = partRowsSchema.parse(
        await (
          await client.query({
            query: `SELECT _part AS part_name FROM ${database}.activity_rows LIMIT 1`,
            format: "JSONEachRow",
            clickhouse_settings: { log_queries: 0 },
          })
        ).json(),
      );
      const name = parts[0]?.part_name;
      if (!name || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unsafe part fixture");
      await client.command({
        query: `ALTER TABLE ${database}.activity_rows DETACH PART '${name}'`,
        clickhouse_settings: { log_queries: 0 },
      });
      await expect(
        fixture.run((owner) => executeAccountErasure(owner, fixture.store, fixture.input, options)),
      ).rejects.toThrow("detached parts");
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120000);

  it("blocks preparation when its retained predecessor history is unavailable", async () => {
    const database = databaseName("account_erasure_history");
    const userId = randomUUID();
    expect(database).toMatch(/^account_erasure_history_[a-f0-9]{32}$/);
    await createDatabase(client, database);
    try {
      await client.command({
        query: `CREATE TABLE ${database}.account_rows (user_id UUID,value String) ENGINE=MergeTree ORDER BY user_id`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) throw new Error("Fixture requires insert");
      await client.insert({
        table: `${database}.account_rows`,
        values: [{ user_id: userId, value: "retained" }],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: "SYSTEM FLUSH LOGS",
        clickhouse_settings: { log_queries: 0, max_threads: 1 },
      });
      expect(
        await queryCount(
          client,
          "SELECT count() AS count FROM system.part_log WHERE database={database:String}",
          { database },
        ),
      ).toBeGreaterThan(0);
      // Remove only this fresh fixture's history, preserving every other database's log rows.
      await client.command({
        query: "ALTER TABLE system.part_log DELETE WHERE database={database:String}",
        query_params: { database },
        clickhouse_settings: { log_queries: 0, max_threads: 1, mutations_sync: "2" },
      });
      const fixture = await physicalFixture(userId);
      await expect(
        fixture.run((owner) =>
          prepareClickHouseAccountErasure(owner, fixture.store, fixture.input, {
            managedDatabases: [database],
          }),
        ),
      ).rejects.toThrow("history is incomplete");
      expect(await fixture.store.loadPhysicalProgress("initial")).toBeNull();
      expect(await tableValues(client, database, "account_rows")).toEqual(["retained"]);
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, database);
    }
  }, 120000);

  it("blocks physical certification when a prior mutation left only inactive personal bytes", async () => {
    const managedDatabase = databaseName("account_erasure_prior_parts");
    const userId = randomUUID();
    await createDatabase(client, managedDatabase);
    try {
      await client.command({
        query: `CREATE TABLE ${managedDatabase}.account_rows (user_id UUID,value String)
        ENGINE=MergeTree ORDER BY user_id SETTINGS old_parts_lifetime=3600`,
        clickhouse_settings: { log_queries: 0 },
      });
      if (!client.insert) throw new Error("ClickHouse fixture requires insert");
      await client.insert({
        table: `${managedDatabase}.account_rows`,
        values: [
          { user_id: userId, value: "old-personal-bytes" },
          { user_id: randomUUID(), value: "survivor" },
        ],
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      await client.command({
        query: `ALTER TABLE ${managedDatabase}.account_rows DELETE WHERE lower(hex(SHA256(toString(user_id))))={hash:String}`,
        query_params: { hash: createHash("sha256").update(userId).digest("hex") },
        clickhouse_settings: { log_queries: 0, mutations_sync: "2" },
      });
      expect(
        await queryCount(
          client,
          `SELECT count() AS count FROM ${managedDatabase}.account_rows WHERE user_id={user_id:UUID}`,
          { user_id: userId },
        ),
      ).toBe(0);
      expect(
        await queryCount(
          client,
          `SELECT count() AS count FROM (SELECT database,table,_state FROM system.parts)
        WHERE database={database:String} AND table='account_rows' AND _state!='Active'`,
          { database: managedDatabase },
        ),
      ).toBeGreaterThan(0);
      await expect(
        eraseClickHouseAccount(
          client,
          { userId, activityIds: [], operationIds: [], sleepSessionIds: [] },
          {
            managedDatabases: [managedDatabase],
            physicalPartPollIntervalMilliseconds: 25,
            physicalPartWaitTimeoutMilliseconds: 100,
          },
        ),
      ).rejects.toThrow("timed out");
    } finally {
      await cleanFences(client, userId, []);
      await dropDatabase(client, managedDatabase);
    }
  }, 120000);

  it("certifies all-state physical absence before retiring completed mutation metadata", async () => {
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
            FROM (SELECT database,table,name,_state FROM system.parts)
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
      await expect(
        queryCount(
          client,
          `SELECT count() AS count FROM system.mutations
            WHERE database={database:String} AND table='account_rows'`,
          { database: managedDatabase },
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

      const queryLogQueryId = `account-erasure-query-log-check-${randomUUID()}`;
      const queryLogResult = await client.query({
        query: `SELECT query, formatted_query
          FROM system.query_log
          WHERE query_id != {inspection_query_id:String}
            AND (
              position(query, {user_identifier:String}) > 0
              OR position(query, {operation_identifier:String}) > 0
              OR position(formatted_query, {user_identifier:String}) > 0
              OR position(formatted_query, {operation_identifier:String}) > 0
            )`,
        query_id: queryLogQueryId,
        query_params: {
          inspection_query_id: queryLogQueryId,
          operation_identifier: operationId,
          user_identifier: userId,
        },
        format: "JSONEachRow",
        clickhouse_settings: { log_queries: 0 },
      });
      expect(queryLogRowsSchema.parse(await queryLogResult.json())).toEqual([]);
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
