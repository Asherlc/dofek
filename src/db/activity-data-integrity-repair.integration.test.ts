import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  failSecondCadenceBatch,
  mirrorRunningLocalTime,
  runningRevisionFixture,
} from "./activity-data-integrity-cadence-test-helpers.ts";
import { queryClickHouseRows } from "./activity-data-integrity-clickhouse.ts";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";
import {
  activityIntegrityFixtureIds,
  bootstrapActivityIntegrityIdentityModels,
  seedProductionDbtFixture,
} from "./activity-data-integrity-dbt-test-helpers.ts";
import {
  type ActivityIntegrityClickHouseClient,
  repairActivityDataIntegrity,
  rollbackActivityDataIntegrity,
} from "./activity-data-integrity-repair.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";
import { executeWithSchema } from "./typed-sql.ts";

const { wahooActivityId, pelotonActivityId, namedZoneActivityId, unrelatedActivityId } =
  activityIntegrityFixtureIds;
const CDC_FIXTURE_TIMEOUT_MS = 120_000;
const dbtEnvironmentKeys = [
  "DBT_TARGET",
  "DBT_CLICKHOUSE_SCHEMA",
  "DBT_ANALYTICS_SOURCE_SCHEMA",
  "DBT_INGEST_SOURCE_SCHEMA",
  "DBT_POSTGRES_FITNESS_SOURCE_SCHEMA",
] as const;
const priorDbtEnvironment = new Map(
  dbtEnvironmentKeys.map((key) => [key, process.env[key]] as const),
);

type NativeClickHouseClient = ReturnType<typeof createClient>;

const postgresLocalTimeContextSchema = z.object({
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.number().int().nullable(),
  end_utc_offset_minutes: z.number().int().nullable(),
  local_time_source: z.string(),
});
const postgresActivitySchema = postgresLocalTimeContextSchema.extend({
  name: z.string().nullable(),
});
const activityIntegrityJournalPhaseSchema = z.object({ phase: z.string() });

describe("activity data integrity repair", () => {
  let context: TestContext;
  let client: NativeClickHouseClient;
  let scopedClient: ActivityIntegrityClickHouseClient;
  let artifactDirectory: string;
  const database = `activity_integrity_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "wahoo", "Wahoo");
    await ensureProvider(context.db, "peloton", "Peloton");
    await ensureProvider(context.db, "apple_health", "Apple Health");
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl)
      throw new Error("CLICKHOUSE_URL is required for activity repair integration tests");
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    scopedClient = scopeClickHouseClient(client, database);
    artifactDirectory = await mkdtemp(join(tmpdir(), "activity-integrity-integration-"));
  }, 300_000);

  beforeEach(async () => {
    await context.db.execute(
      sql`DELETE FROM fitness.activity WHERE user_id=${TEST_USER_ID}::uuid AND provider_id='apple_health'`,
    );
    await seedPostgres(context);
    await rm(artifactDirectory, { recursive: true, force: true });
    await mkdir(artifactDirectory, { mode: 0o700 });
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of priorDbtEnvironment) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
    await context?.cleanup();
  }, 120_000);

  it("reads ClickHouse UTC timestamps with an explicit zone and preserves fractional seconds", async () => {
    const rows = await queryClickHouseRows(
      client,
      z.object({ started_at: z.string().datetime(), ended_at: z.string().datetime().nullable() }),
      `SELECT toDateTime64('2026-09-01 23:30:00.123456', 6, 'UTC') AS started_at,
        CAST(NULL AS Nullable(DateTime64(6, 'UTC'))) AS ended_at`,
      {},
    );
    expect(rows).toEqual([{ started_at: "2026-09-01T23:30:00.123456Z", ended_at: null }]);
    expect(new Date(rows[0]?.started_at ?? "").toISOString()).toBe("2026-09-01T23:30:00.123Z");
  });

  it("finishes 101 revision/member aliases, old-group tombstones and downstream cadence before returning", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    await bootstrapActivityIntegrityIdentityModels();
    const fixture = runningRevisionFixture(TEST_USER_ID);
    const { records } = fixture;
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: fixture.initialActivityRows,
    });
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: fixture.initialStepRows,
    });
    const input = {
      userId: TEST_USER_ID,
      activityIds: records.map((record) => record.member),
      eventTimeStart: new Date("2026-09-01"),
      eventTimeEnd: new Date("2026-09-03"),
    };
    const cadenceRows = async () => {
      const result = await client.query({
        query: `SELECT activity_id,avg_cadence,is_deleted FROM ${database}.activity_step_cadence_rows FINAL WHERE user_id={user:UUID}`,
        query_params: { user: TEST_USER_ID },
        format: "JSONEachRow",
      });
      return result.json<{ activity_id: string; avg_cadence: number | null; is_deleted: number }>();
    };
    // Establish every old row before testing correction of the entire canonical scope.
    await runActivityIntegrityDbtBuild(input, scopedClient);
    await runActivityIntegrityDbtBuild(input, scopedClient);
    const before = await cadenceRows();
    expect(before).toHaveLength(101);
    expect(before).toEqual(
      expect.arrayContaining(
        records.map((record) => ({
          activity_id: record.group,
          avg_cadence: 150,
          is_deleted: 0,
        })),
      ),
    );

    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: fixture.revisedActivityRows,
    });
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: fixture.revisedStepRows,
    });
    await runActivityIntegrityDbtBuild(input, scopedClient);
    const cadence = await cadenceRows();
    expect(cadence).toHaveLength(202);
    expect(cadence.filter((row) => row.is_deleted === 0)).toHaveLength(101);
    for (const record of records) {
      expect(cadence.find((row) => row.activity_id === record.group)).toMatchObject({
        is_deleted: 1,
        avg_cadence: null,
      });
      expect(cadence.find((row) => row.activity_id === record.nextGroup)).toMatchObject({
        is_deleted: 0,
        avg_cadence: 180,
      });
    }
    const summaries = await client.query({
      query: `SELECT activity_id,avg_cadence FROM ${database}.activity_summary_rows FINAL WHERE user_id={user:UUID} AND is_deleted=0 AND activity_id IN {ids:Array(UUID)}`,
      query_params: { user: TEST_USER_ID, ids: records.map((record) => record.nextGroup) },
      format: "JSONEachRow",
    });
    const summaryRows = await summaries.json();
    expect(summaryRows).toHaveLength(101);
    expect(summaryRows).toEqual(
      expect.arrayContaining(
        records.map((record) => ({
          activity_id: record.nextGroup,
          avg_cadence: 180,
        })),
      ),
    );
    const foreign = await client.query({
      query: `SELECT count() AS count FROM ${database}.activity_step_cadence_rows FINAL WHERE user_id={user:UUID}`,
      query_params: { user: fixture.foreignUserId },
      format: "JSONEachRow",
    });
    expect(await foreign.json()).toEqual([{ count: "0" }]);
  }, 300_000);

  it("creates an empty exact cadence target without selecting another user's running group", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    const foreignUser = randomUUID();
    const fixture = runningRevisionFixture(foreignUser);
    const foreign = fixture.initialActivityRows[0];
    if (!foreign) throw new Error("Missing foreign fixture activity");
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [foreign],
    });
    await bootstrapActivityIntegrityIdentityModels();
    await runActivityIntegrityDbtBuild(
      {
        userId: TEST_USER_ID,
        activityIds: [wahooActivityId],
        eventTimeStart: new Date("2026-09-01"),
        eventTimeEnd: new Date("2026-09-03"),
      },
      scopedClient,
    );
    const result = await client.query({
      query: `SELECT count() AS count FROM ${database}.activity_step_cadence_rows FINAL`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ count: "0" }]);
  }, 300_000);

  it.each(["repair", "rollback"] as const)(
    "keeps %s journal state on a second cadence batch failure and completes all101 on rollback",
    async (failureStage) => {
      await seedProductionDbtFixture(client, database);
      configureDbtEnvironment(database);
      await bootstrapActivityIntegrityIdentityModels();
      const fixture = runningRevisionFixture(TEST_USER_ID);
      const ids = fixture.records.map((record) => record.member);
      await context.db.execute(sql`INSERT INTO fitness.activity
      (id,group_id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,ended_at,raw,local_time_source)
      SELECT id::uuid,group_id::uuid,user_id::uuid,provider_id,external_id,canonical_type,provider_type,
        started_at::timestamptz,ended_at::timestamptz,raw::jsonb,local_time_source
      FROM jsonb_to_recordset(${JSON.stringify(fixture.initialActivityRows.filter((row) => row.user_id === TEST_USER_ID))}::jsonb)
      AS r(id text,group_id text,user_id text,provider_id text,external_id text,canonical_type text,provider_type text,
        started_at text,ended_at text,raw text,local_time_source text)`);
      await client.insert({
        table: `${database}.activity`,
        format: "JSONEachRow",
        values: fixture.initialActivityRows,
      });
      await client.insert({
        table: `${database}.metric_stream`,
        format: "JSONEachRow",
        values: fixture.initialStepRows,
      });
      await runActivityIntegrityDbtBuild(
        {
          userId: TEST_USER_ID,
          activityIds: ids,
          eventTimeStart: new Date("2026-09-01"),
          eventTimeEnd: new Date("2026-09-03"),
        },
        scopedClient,
      );
      const snapshot = async (table: string) => {
        const result = await client.query({
          query: `SELECT activity_id,avg_cadence,toString(refresh_version) AS refresh_version FROM ${database}.${table} FINAL WHERE user_id={user:UUID} AND activity_id IN {ids:Array(UUID)} ORDER BY activity_id`,
          query_params: { user: TEST_USER_ID, ids: fixture.records.map((record) => record.group) },
          format: "JSONEachRow",
        });
        return result.json<{
          activity_id: string;
          avg_cadence: number | null;
          refresh_version: string;
        }>();
      };
      const correctSteps = async (value: number, version: number) =>
        client.insert({
          table: `${database}.metric_stream`,
          format: "JSONEachRow",
          values: fixture.initialStepRows.map((row) => ({
            ...row,
            scalar: value,
            version,
            ingested_at: `2026-09-02 17:00:0${version}`,
          })),
        });
      await correctSteps(180, 2);
      const runId = randomUUID();
      const dependencies = {
        artifactDirectory,
        now: () => new Date("2026-09-02T18:01:00Z"),
        generateRunId: () => runId,
        sleep: () => mirrorRunningLocalTime(context, client, database, ids),
      };
      const options = {
        userId: TEST_USER_ID,
        startAt: new Date("2026-09-01T07:00:00Z"),
        endAt: new Date("2026-09-01T09:00:00Z"),
        execute: true,
        batchSize: 1000,
        maxBatches: 1,
        artifactDirectory,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: new Date("2026-09-03T18:00:00Z"),
      };
      let summaryBefore = await snapshot("activity_summary_rows");
      let cadenceBefore = await snapshot("activity_step_cadence_rows");
      expect(cadenceBefore).toHaveLength(101);
      if (failureStage === "repair") {
        await expect(
          repairActivityDataIntegrity(
            context.db,
            failSecondCadenceBatch(client, scopedClient, database),
            options,
            dependencies,
          ),
        ).rejects.toThrow("failed with exit code");
        await expect(activityIntegrityJournalPhase(context, runId)).resolves.toBe("rebuild_failed");
      } else {
        await repairActivityDataIntegrity(context.db, scopedClient, options, dependencies);
        await expect(activityIntegrityJournalPhase(context, runId)).resolves.toBe("executed");
        expect((await snapshot("activity_summary_rows")).map((row) => row.avg_cadence)).toEqual(
          Array(101).fill(180),
        );
        summaryBefore = await snapshot("activity_summary_rows");
        cadenceBefore = await snapshot("activity_step_cadence_rows");
        await correctSteps(200, 3);
      }
      const [artifactName] = await readdir(artifactDirectory);
      if (!artifactName) throw new Error("Missing repair artifact");
      const artifactPath = join(artifactDirectory, artifactName);
      if (failureStage === "rollback") {
        await expect(
          rollbackActivityDataIntegrity(
            context.db,
            failSecondCadenceBatch(client, scopedClient, database),
            artifactPath,
            dependencies,
          ),
        ).rejects.toThrow("failed with exit code");
        await expect(activityIntegrityJournalPhase(context, runId)).resolves.toBe(
          "rollback_committed",
        );
      }
      const partial = await snapshot("activity_step_cadence_rows");
      const beforeVersions = new Map(
        cadenceBefore.map((row) => [row.activity_id, BigInt(row.refresh_version)]),
      );
      expect(
        partial.filter(
          (row) => BigInt(row.refresh_version) > (beforeVersions.get(row.activity_id) ?? 0n),
        ),
      ).toHaveLength(100);
      expect(await snapshot("activity_summary_rows")).toEqual(summaryBefore);
      expect(JSON.parse(await readFile(artifactPath, "utf8"))).toMatchObject({
        phase: failureStage === "repair" ? "rebuild_failed" : "rollback_committed",
      });
      await client.command({
        query: `CREATE TABLE ${database}.metric_stream_day_change (
      user_id UUID,provider_id String,recorded_date Date,changed_at SimpleAggregateFunction(max,DateTime64(9,'UTC'))
    ) ENGINE=AggregatingMergeTree ORDER BY (user_id,provider_id,recorded_date)`,
      });
      await rollbackActivityDataIntegrity(context.db, scopedClient, artifactPath, dependencies);
      await expect(activityIntegrityJournalPhase(context, runId)).resolves.toBe("rolled_back");
      expect((await snapshot("activity_step_cadence_rows")).map((row) => row.avg_cadence)).toEqual(
        Array(101).fill(failureStage === "repair" ? 180 : 200),
      );
      expect((await snapshot("activity_summary_rows")).map((row) => row.avg_cadence)).toEqual(
        Array(101).fill(failureStage === "repair" ? 180 : 200),
      );
    },
    300_000,
  );

  it("uses the production dbt path to split a legacy Wahoo/Peloton component, preserve its valid B-C edge, and roll back only local time", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    await bootstrapActivityIntegrityIdentityModels();
    await runActivityIntegrityDbtBuild(
      {
        userId: TEST_USER_ID,
        activityIds: [wahooActivityId, pelotonActivityId, namedZoneActivityId, unrelatedActivityId],
        eventTimeStart: new Date("2026-09-01T00:00:00.000Z"),
        eventTimeEnd: new Date("2026-09-03T00:00:00.000Z"),
      },
      scopedClient,
    );
    await seedLegacyFalseComponent(client, database);
    const unrelatedBefore = await taskThreeRowsForActivity(client, database, unrelatedActivityId);
    const [repaired] = await Promise.all([
      repairActivityDataIntegrity(
        context.db,
        scopedClient,
        {
          execute: true,
          userId: TEST_USER_ID,
          startAt: new Date("2026-09-01T00:00:00.000Z"),
          endAt: new Date("2026-09-02T00:00:00.000Z"),
          batchSize: 10,
          maxBatches: 1,
          artifactDirectory,
          acceptanceOwner: "data-on-call@example.com",
          acceptanceDeadline: new Date("2026-09-03T18:01:00.000Z"),
        },
        {
          now: () => new Date("2026-09-02T18:01:00.000Z"),
          generateRunId: randomUUID,
          cdcReadinessPollIntervalMs: 10,
        },
      ),
      mirrorPostgresCommit(context, client, database),
    ]);

    expect(repaired).toMatchObject({
      selected: 3,
      changed: 3,
      updated: 3,
      beforeComponentCount: 1,
      afterComponentCount: 2,
    });
    await expect(clickHouseLocalTimeContext(client, database, pelotonActivityId)).resolves.toEqual({
      timezone: "America/Los_Angeles",
      start_utc_offset_minutes: -420,
      end_utc_offset_minutes: -420,
      local_time_source: "home_zone_fallback",
    });
    await assertCorrectDerivedActivityState(client, database, "repaired");
    await expect(activityIntegrityJournalPhase(context, repaired.runId)).resolves.toBe("executed");
    expect(await postgresLocalTimeContext(context, pelotonActivityId)).toEqual({
      timezone: "America/Los_Angeles",
      start_utc_offset_minutes: -420,
      end_utc_offset_minutes: -420,
      local_time_source: "home_zone_fallback",
    });
    expect(await postgresLocalTimeContext(context, namedZoneActivityId)).toEqual({
      timezone: "America/Los_Angeles",
      start_utc_offset_minutes: -420,
      end_utc_offset_minutes: -420,
      local_time_source: "home_zone_fallback",
    });
    await context.db.execute(sql`
      UPDATE fitness.activity
      SET name = 'Provider title updated after repair', raw = '{"revision":"later-provider-sync"}'::jsonb
      WHERE id = ${pelotonActivityId}::uuid
    `);
    const [rolledBack] = await Promise.all([
      rollbackActivityDataIntegrity(context.db, scopedClient, repaired.artifactPath, {
        now: () => new Date("2026-09-02T18:02:00.000Z"),
      }),
      mirrorPostgresRollback(context, client, database),
    ]);
    expect(rolledBack).toMatchObject({ runId: repaired.runId, updated: 3 });
    await assertCorrectDerivedActivityState(client, database, "rolled back");
    await expect(activityIntegrityJournalPhase(context, repaired.runId)).resolves.toBe(
      "rolled_back",
    );
    expect(await postgresLocalTimeContext(context, pelotonActivityId)).toEqual({
      timezone: "Etc/GMT+4",
      start_utc_offset_minutes: -300,
      end_utc_offset_minutes: -300,
      local_time_source: "provider_timezone",
    });
    await expect(postgresActivityName(context, pelotonActivityId)).resolves.toBe(
      "Provider title updated after repair",
    );
    await expect(taskThreeRowsForActivity(client, database, unrelatedActivityId)).resolves.toEqual(
      unrelatedBefore,
    );
    const artifact = JSON.parse(await readFile(repaired.artifactPath, "utf8"));
    expect(artifact).toMatchObject({ phase: "rolled_back", rollbackEligibility: "not_applicable" });
  }, 300_000);
});

async function seedPostgres(context: TestContext): Promise<void> {
  await context.db.execute(sql`
    INSERT INTO fitness.user_settings (user_id, key, value)
    VALUES (${TEST_USER_ID}::uuid, 'homeTimezone', '"America/Los_Angeles"'::jsonb)
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value
  `);
  await context.db.execute(sql`
    DELETE FROM fitness.activity
    WHERE id IN (${wahooActivityId}::uuid, ${pelotonActivityId}::uuid, ${namedZoneActivityId}::uuid)
  `);
  await context.db.execute(sql`
    INSERT INTO fitness.activity (
      id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, timezone, start_utc_offset_minutes,
      end_utc_offset_minutes, local_time_source
    ) VALUES
      (
        ${wahooActivityId}::uuid, ${wahooActivityId}::uuid, 'wahoo', ${TEST_USER_ID}::uuid, 'wahoo-ride',
        'other', 'workout', '2026-09-01T14:50:00Z', '2026-09-01T15:30:00Z',
        NULL, NULL, NULL, 'unknown'
      ),
      (
        ${pelotonActivityId}::uuid, ${pelotonActivityId}::uuid, 'peloton', ${TEST_USER_ID}::uuid, 'peloton-ride',
        'cycling', 'cycling', '2026-09-01T14:55:54Z', '2026-09-01T15:25:54Z',
        'Etc/GMT+4', -300, -300, 'provider_timezone'
      ),
      (
        ${namedZoneActivityId}::uuid, ${pelotonActivityId}::uuid, 'wahoo', ${TEST_USER_ID}::uuid, 'named-zone-ride',
        'cycling', 'cycling', '2026-09-01T15:00:00Z', '2026-09-01T15:30:00Z',
        'America/New_York', -420, -420, 'provider_timezone'
      )
  `);
}

function configureDbtEnvironment(database: string): void {
  process.env.DBT_TARGET = "dev";
  process.env.DBT_CLICKHOUSE_SCHEMA = database;
  process.env.DBT_ANALYTICS_SOURCE_SCHEMA = database;
  process.env.DBT_INGEST_SOURCE_SCHEMA = database;
  process.env.DBT_POSTGRES_FITNESS_SOURCE_SCHEMA = database;
}

async function seedLegacyFalseComponent(
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const refreshVersion = "toUInt64(toUnixTimestamp64Nano(now64(9)) - 1000000)";
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_matches VALUES
      ('${wahooActivityId}', '${pelotonActivityId}', 0.95, ${refreshVersion}, 0, now64(9))`,
  });
  await client.command({
    query: `INSERT INTO ${database}.activity_duplicate_groups VALUES
      ('${wahooActivityId}', '${wahooActivityId}', ${refreshVersion}, 0, now64(9)),
      ('${pelotonActivityId}', '${wahooActivityId}', ${refreshVersion}, 0, now64(9)),
      ('${namedZoneActivityId}', '${wahooActivityId}', ${refreshVersion}, 0, now64(9))`,
  });
}

async function mirrorPostgresCommit(
  context: TestContext,
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const deadline = performance.now() + CDC_FIXTURE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const wahoo = await postgresLocalTimeContext(context, wahooActivityId);
    const peloton = await postgresLocalTimeContext(context, pelotonActivityId);
    const namedZone = await postgresLocalTimeContext(context, namedZoneActivityId);
    if (
      wahoo?.local_time_source === "home_zone_fallback" &&
      peloton?.timezone === "America/Los_Angeles" &&
      peloton?.start_utc_offset_minutes === -420 &&
      namedZone?.start_utc_offset_minutes === -420
    ) {
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            'America/Los_Angeles' AS timezone,
            toInt16(-420) AS start_utc_offset_minutes,
            toInt16(-420) AS end_utc_offset_minutes,
            'home_zone_fallback' AS local_time_source,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${wahooActivityId}'`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            'America/Los_Angeles' AS timezone,
            toInt16(-420) AS start_utc_offset_minutes,
            toInt16(-420) AS end_utc_offset_minutes,
            'home_zone_fallback' AS local_time_source,
            'Etc/GMT+4' AS rejected_provider_timezone,
            toInt64(-300) AS rejected_provider_start_utc_offset_minutes,
            toInt64(-300) AS rejected_provider_end_utc_offset_minutes,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${pelotonActivityId}'`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            'America/Los_Angeles' AS timezone,
            toInt16(-420) AS start_utc_offset_minutes,
            toInt16(-420) AS end_utc_offset_minutes,
            'home_zone_fallback' AS local_time_source,
            'America/New_York' AS rejected_provider_timezone,
            toInt64(-420) AS rejected_provider_start_utc_offset_minutes,
            toInt64(-420) AS rejected_provider_end_utc_offset_minutes,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${namedZoneActivityId}'`,
      });
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("PostgreSQL repair commit was not observed by the integration CDC fixture");
}

async function mirrorPostgresRollback(
  context: TestContext,
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const deadline = performance.now() + CDC_FIXTURE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const wahoo = await postgresActivity(context, wahooActivityId);
    const peloton = await postgresActivity(context, pelotonActivityId);
    const namedZone = await postgresActivity(context, namedZoneActivityId);
    if (
      wahoo?.local_time_source === "unknown" &&
      peloton?.timezone === "Etc/GMT+4" &&
      peloton.start_utc_offset_minutes === -300 &&
      peloton.name === "Provider title updated after repair" &&
      namedZone?.timezone === "America/New_York" &&
      namedZone.start_utc_offset_minutes === -420
    ) {
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            CAST(NULL, 'Nullable(String)') AS timezone,
            CAST(NULL, 'Nullable(Int16)') AS start_utc_offset_minutes,
            CAST(NULL, 'Nullable(Int16)') AS end_utc_offset_minutes,
            'unknown' AS local_time_source,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${wahooActivityId}'`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            'Provider title updated after repair' AS name,
            'Etc/GMT+4' AS timezone,
            toInt16(-300) AS start_utc_offset_minutes,
            toInt16(-300) AS end_utc_offset_minutes,
            'provider_timezone' AS local_time_source,
            CAST(NULL, 'Nullable(String)') AS rejected_provider_timezone,
            CAST(NULL, 'Nullable(Int64)') AS rejected_provider_start_utc_offset_minutes,
            CAST(NULL, 'Nullable(Int64)') AS rejected_provider_end_utc_offset_minutes,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${pelotonActivityId}'`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity
          SELECT * REPLACE(
            'America/New_York' AS timezone,
            toInt16(-420) AS start_utc_offset_minutes,
            toInt16(-420) AS end_utc_offset_minutes,
            'provider_timezone' AS local_time_source,
            CAST(NULL, 'Nullable(String)') AS rejected_provider_timezone,
            CAST(NULL, 'Nullable(Int64)') AS rejected_provider_start_utc_offset_minutes,
            CAST(NULL, 'Nullable(Int64)') AS rejected_provider_end_utc_offset_minutes,
            now64(9) AS _peerdb_synced_at,
            _peerdb_version + 100 AS _peerdb_version
          )
          FROM ${database}.activity FINAL
          WHERE id = '${namedZoneActivityId}'`,
      });
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("PostgreSQL rollback commit was not observed by the integration CDC fixture");
}

async function clickHouseLocalTimeContext(
  client: NativeClickHouseClient,
  database: string,
  activityId: string,
) {
  const response = await client.query({
    query: `SELECT
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      FROM ${database}.activity_source_records FINAL
      WHERE activity_id = {activityId:UUID} AND is_deleted = 0`,
    query_params: { activityId },
    format: "JSONEachRow",
  });
  return (await response.json())[0];
}

const affectedActivityIds = [wahooActivityId, pelotonActivityId, namedZoneActivityId];
const affectedActivityIdList = affectedActivityIds
  .map((activityId) => `'${activityId}'`)
  .join(", ");

async function queryDerivedRows<T extends object>(
  client: NativeClickHouseClient,
  query: string,
): Promise<T[]> {
  const response = await client.query({ query, format: "JSONEachRow" });
  return response.json<T>();
}

async function assertCorrectDerivedActivityState(
  client: NativeClickHouseClient,
  database: string,
  lifecycle: "repaired" | "rolled back",
): Promise<void> {
  const sourceRows = await queryDerivedRows<{
    activity_id: string;
    provider_id: string;
    canonical_type: string;
    timezone: string | null;
    start_utc_offset_minutes: number | null;
    end_utc_offset_minutes: number | null;
    local_time_source: string;
  }>(
    client,
    `SELECT
        toString(activity_id) AS activity_id,
        provider_id,
        canonical_type,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      FROM ${database}.activity_source_records FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );
  const matches = await queryDerivedRows<{
    activity_id: string;
    duplicate_activity_id: string;
  }>(
    client,
    `SELECT toString(activity_id) AS activity_id, toString(duplicate_activity_id) AS duplicate_activity_id
      FROM ${database}.activity_duplicate_matches FINAL
      WHERE is_deleted = 0
        AND activity_id IN (${affectedActivityIdList})
        AND duplicate_activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id, duplicate_activity_id`,
  );
  const groups = await queryDerivedRows<{ activity_id: string; group_id: string }>(
    client,
    `SELECT toString(activity_id) AS activity_id, group_id
      FROM ${database}.activity_duplicate_groups FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );
  const dedupedRows = await queryDerivedRows<{
    activity_id: string;
    member_activity_ids: string[];
  }>(
    client,
    `SELECT
        toString(activity_id) AS activity_id,
        arrayMap(value -> toString(value), member_activity_ids) AS member_activity_ids
      FROM ${database}.deduped_activities FINAL
      WHERE is_deleted = 0 AND hasAny(member_activity_ids, [${affectedActivityIdList}])
      ORDER BY activity_id`,
  );
  const memberRows = await queryDerivedRows<{
    activity_id: string;
    member_activity_id: string;
  }>(
    client,
    `SELECT toString(activity_id) AS activity_id, toString(member_activity_id) AS member_activity_id
      FROM ${database}.deduped_activity_members FINAL
      WHERE is_deleted = 0 AND member_activity_id IN (${affectedActivityIdList})
      ORDER BY member_activity_id`,
  );
  const sensorSummaryRows = await queryDerivedRows<{ activity_id: string }>(
    client,
    `SELECT toString(activity_id) AS activity_id
      FROM ${database}.activity_sensor_summary_rows FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );
  const summaryRows = await queryDerivedRows<{ activity_id: string }>(
    client,
    `SELECT toString(activity_id) AS activity_id
      FROM ${database}.activity_summary_rows FINAL
      WHERE is_deleted = 0 AND activity_id IN (${affectedActivityIdList})
      ORDER BY activity_id`,
  );

  const expectedPeloton =
    lifecycle === "repaired"
      ? {
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "home_zone_fallback",
        }
      : {
          timezone: "Etc/GMT+4",
          start_utc_offset_minutes: -300,
          end_utc_offset_minutes: -300,
          local_time_source: "provider_timezone",
        };
  const expectedNamedZone =
    lifecycle === "repaired"
      ? {
          timezone: "America/Los_Angeles",
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "home_zone_fallback",
        }
      : {
          timezone: "America/New_York",
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_timezone",
        };

  expect(sourceRows).toEqual([
    {
      activity_id: wahooActivityId,
      provider_id: "wahoo",
      canonical_type: "other",
      timezone: lifecycle === "repaired" ? "America/Los_Angeles" : null,
      start_utc_offset_minutes: lifecycle === "repaired" ? -420 : null,
      end_utc_offset_minutes: lifecycle === "repaired" ? -420 : null,
      local_time_source: lifecycle === "repaired" ? "home_zone_fallback" : "unknown",
    },
    {
      activity_id: pelotonActivityId,
      provider_id: "peloton",
      canonical_type: "cycling",
      ...expectedPeloton,
    },
    {
      activity_id: namedZoneActivityId,
      provider_id: "wahoo",
      canonical_type: "cycling",
      ...expectedNamedZone,
    },
  ]);
  expect(matches.map((row) => [row.activity_id, row.duplicate_activity_id].sort())).toEqual([
    [pelotonActivityId, namedZoneActivityId].sort(),
  ]);
  const wahooGroup = groups.find((row) => row.activity_id === wahooActivityId)?.group_id;
  const pelotonGroup = groups.find((row) => row.activity_id === pelotonActivityId)?.group_id;
  const namedZoneGroup = groups.find((row) => row.activity_id === namedZoneActivityId)?.group_id;
  expect(wahooGroup).toBeTruthy();
  expect(pelotonGroup).toBeTruthy();
  expect(wahooGroup).not.toBe(pelotonGroup);
  expect(pelotonGroup).toBe(namedZoneGroup);
  expect(dedupedRows.map((row) => [...row.member_activity_ids].sort()).sort()).toEqual([
    [wahooActivityId],
    [pelotonActivityId, namedZoneActivityId].sort(),
  ]);
  expect(memberRows).toHaveLength(3);
  const wahooMembership = memberRows.find((row) => row.member_activity_id === wahooActivityId);
  const pelotonMembership = memberRows.find((row) => row.member_activity_id === pelotonActivityId);
  const namedZoneMembership = memberRows.find(
    (row) => row.member_activity_id === namedZoneActivityId,
  );
  expect(wahooMembership?.activity_id).not.toBe(pelotonMembership?.activity_id);
  expect(pelotonMembership?.activity_id).toBe(namedZoneMembership?.activity_id);
  const canonicalActivityIds = dedupedRows.map((row) => row.activity_id).sort();
  expect(sensorSummaryRows.map((row) => row.activity_id)).toEqual(canonicalActivityIds);
  expect(summaryRows.map((row) => row.activity_id)).toEqual(canonicalActivityIds);
}

async function taskThreeRowsForActivity(
  client: NativeClickHouseClient,
  database: string,
  activityId: string,
): Promise<Array<{ model: string; rows: unknown[] }>> {
  const models = [
    ["activity_source_records", "activity_id = {activityId:UUID}"],
    [
      "activity_duplicate_matches",
      "activity_id = {activityId:UUID} OR duplicate_activity_id = {activityId:UUID}",
    ],
    ["activity_duplicate_groups", "activity_id = {activityId:UUID}"],
    [
      "deduped_activities",
      "activity_id = {activityId:UUID} OR has(member_activity_ids, {activityId:UUID})",
    ],
    [
      "deduped_activity_members",
      "activity_id = {activityId:UUID} OR member_activity_id = {activityId:UUID}",
    ],
    ["activity_sensor_summary_rows", "activity_id = {activityId:UUID}"],
    ["activity_summary_rows", "activity_id = {activityId:UUID}"],
  ] as const;
  const snapshots = [];
  for (const [model, filter] of models) {
    const response = await client.query({
      query: `SELECT * REPLACE(toString(refresh_version) AS refresh_version)
        FROM ${database}.${model} FINAL
        WHERE ${filter}
        ORDER BY tuple(*)`,
      query_params: { activityId },
      format: "JSONEachRow",
      clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
    });
    snapshots.push({ model, rows: await response.json() });
  }
  return snapshots;
}

function scopeClickHouseClient(
  client: NativeClickHouseClient,
  database: string,
): ActivityIntegrityClickHouseClient {
  const scope = (query: string) =>
    query.replaceAll("analytics.", `${database}.`).replaceAll("postgres_fitness.", `${database}.`);
  return {
    query: async (options) => {
      const result = await client.query({ ...options, query: scope(options.query) });
      return { json: () => result.json() };
    },
    insert: (options) =>
      client.insert({ ...options, table: scope(options.table), values: [...options.values] }),
  };
}

async function postgresLocalTimeContext(context: TestContext, activityId: string) {
  const rows = await executeWithSchema(
    context.db,
    postgresLocalTimeContextSchema,
    sql`
      SELECT timezone, start_utc_offset_minutes::integer, end_utc_offset_minutes::integer,
        local_time_source
      FROM fitness.activity
      WHERE id = ${activityId}::uuid
    `,
  );
  return rows[0];
}

async function postgresActivity(context: TestContext, activityId: string) {
  const rows = await executeWithSchema(
    context.db,
    postgresActivitySchema,
    sql`
      SELECT
        timezone,
        start_utc_offset_minutes::integer,
        end_utc_offset_minutes::integer,
        local_time_source,
        name
      FROM fitness.activity
      WHERE id = ${activityId}::uuid
    `,
  );
  return rows[0];
}

async function postgresActivityName(
  context: TestContext,
  activityId: string,
): Promise<string | null> {
  return (await postgresActivity(context, activityId))?.name ?? null;
}

async function activityIntegrityJournalPhase(
  context: TestContext,
  runId: string,
): Promise<string | null> {
  const rows = await executeWithSchema(
    context.db,
    activityIntegrityJournalPhaseSchema,
    sql`
      SELECT phase
      FROM fitness.activity_integrity_repair_journal
      WHERE run_id = ${runId}::uuid
    `,
  );
  return rows[0]?.phase ?? null;
}
