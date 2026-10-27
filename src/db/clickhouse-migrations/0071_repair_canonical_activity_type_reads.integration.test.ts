import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../clickhouse.ts";
import { buildActivitySummaryRowsTableSql } from "../clickhouse-activity-summary.ts";
import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import { createMigration } from "./0071_repair_canonical_activity_type_reads.ts";

/**
 * The activity summary view body as it stood before 0069 renamed `activity_type` to
 * `canonical_type`. Recreating it verbatim puts the isolated database into the state
 * production reached: a stored view body that outlived the column it selects.
 */
const staleActivitySummaryViewSql = `CREATE VIEW analytics.activity_summary
AS
SELECT
  activity_id,
  user_id,
  assumeNotNull(activity_type) AS activity_type,
  name,
  assumeNotNull(started_at) AS started_at,
  ended_at,
  refreshed_at
FROM analytics.activity_summary_rows FINAL
WHERE is_deleted = 0`;

const summaryRowsSchema = z.array(
  z.object({
    canonical_type: z.string(),
    provider_type: z.string().nullable(),
    modality: z.string().nullable(),
  }),
);

const provenanceRowsSchema = z.array(
  z.object({
    activity_id: z.string(),
    provider_type: z.string().nullable(),
    modality: z.string().nullable(),
    is_deleted: z.number(),
  }),
);

const outdoorActivityId = "11111111-1111-4111-8111-111111111111";
const indoorActivityId = "22222222-2222-4222-8222-222222222222";
const tombstonedActivityId = "33333333-3333-4333-8333-333333333333";
const absentFromReplicaActivityId = "44444444-4444-4444-8444-444444444444";

const provenanceServingTables = [
  "activity_source_records",
  "cycling_activity",
  "deduped_activities",
];

describe("0071_repair_canonical_activity_type_reads migration", () => {
  const database = `repair_canonical_reads_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  async function runIsolated(statement: string): Promise<void> {
    await client.command({
      query: statement
        .replaceAll("analytics.", `${database}.`)
        .replaceAll("postgres_fitness.", `${database}.`),
    });
  }

  async function applyMigrationStatements(): Promise<void> {
    for (const statement of createMigration().statements) {
      await runIsolated(statement);
    }
  }

  async function readProvenance(activityId: string) {
    const result = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, provider_type, modality, is_deleted
        FROM ${database}.deduped_activities
        WHERE activity_id = '${activityId}'`,
      format: "JSONEachRow",
    });
    return provenanceRowsSchema.parse(await result.json());
  }

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });

    for (const statement of buildPostgresFitnessRawTableStatements()) {
      await runIsolated(statement);
    }
    await runIsolated(buildActivitySummaryRowsTableSql());
    for (const table of provenanceServingTables) {
      await runIsolated(`CREATE TABLE analytics.${table} (
  activity_id UUID,
  user_id UUID,
  canonical_type Nullable(String),
  provider_type Nullable(String),
  modality Nullable(String),
  is_deleted UInt8
)
ENGINE = MergeTree
ORDER BY activity_id`);
    }

    // Restore the pre-0069 column name, install the view that read it, then apply the
    // rename exactly as 0069 did. The view body is now stale against its own source table.
    await runIsolated(
      "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN canonical_type TO activity_type",
    );
    await runIsolated(staleActivitySummaryViewSql);
    await runIsolated(
      "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN activity_type TO canonical_type",
    );

    await client.command({
      query: `INSERT INTO ${database}.activity
        (id, provider_id, user_id, canonical_type, provider_type, modality, started_at, created_at, _peerdb_is_deleted)
        VALUES
        ('${outdoorActivityId}', 'wahoo', '${outdoorActivityId}', 'cycling', 'road_cycling', 'road', now64(6), now64(6), 0),
        ('${indoorActivityId}', 'zwift', '${indoorActivityId}', 'cycling', 'virtual_cycling', NULL, now64(6), now64(6), 0),
        ('${tombstonedActivityId}', 'whoop', '${tombstonedActivityId}', 'running', 'trail_running', 'trail', now64(6), now64(6), 0)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows
        (activity_id, user_id, canonical_type, provider_type, modality, started_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${outdoorActivityId}', '${outdoorActivityId}', 'cycling', NULL, NULL, now64(6), 1, 0, now64(9))`,
    });
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities
        (activity_id, user_id, canonical_type, provider_type, modality, is_deleted)
        VALUES
        ('${outdoorActivityId}', '${outdoorActivityId}', 'cycling', NULL, NULL, 0),
        ('${indoorActivityId}', '${indoorActivityId}', 'cycling', NULL, NULL, 0),
        ('${tombstonedActivityId}', '${tombstonedActivityId}', 'running', NULL, NULL, 1),
        ('${absentFromReplicaActivityId}', '${absentFromReplicaActivityId}', 'walking', NULL, NULL, 0)`,
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  });

  it("cannot read the stale view before the migration runs", async () => {
    await expect(
      client.query({
        query: `SELECT activity_id FROM ${database}.activity_summary`,
        format: "JSONEachRow",
      }),
    ).rejects.toThrow(/activity_type/);
  });

  describe("after the migration statements are applied", () => {
    beforeAll(async () => {
      await applyMigrationStatements();
    });

    it("serves the canonical column through the repaired view", async () => {
      const result = await client.query({
        query: `SELECT canonical_type, provider_type, modality FROM ${database}.activity_summary`,
        format: "JSONEachRow",
      });

      expect(summaryRowsSchema.parse(await result.json())).toEqual([
        { canonical_type: "cycling", provider_type: "road_cycling", modality: "road" },
      ]);
    });

    it("copies provenance onto live rows that were left without it", async () => {
      expect(await readProvenance(outdoorActivityId)).toEqual([
        {
          activity_id: outdoorActivityId,
          provider_type: "road_cycling",
          modality: "road",
          is_deleted: 0,
        },
      ]);
    });

    it("keeps a null modality null rather than inventing one", async () => {
      expect(await readProvenance(indoorActivityId)).toEqual([
        {
          activity_id: indoorActivityId,
          provider_type: "virtual_cycling",
          modality: null,
          is_deleted: 0,
        },
      ]);
    });

    it("leaves tombstoned rows untouched", async () => {
      expect(await readProvenance(tombstonedActivityId)).toEqual([
        {
          activity_id: tombstonedActivityId,
          provider_type: null,
          modality: null,
          is_deleted: 1,
        },
      ]);
    });

    it("records provenance for an activity missing from the replica as null, not an empty string", async () => {
      expect(await readProvenance(absentFromReplicaActivityId)).toEqual([
        {
          activity_id: absentFromReplicaActivityId,
          provider_type: null,
          modality: null,
          is_deleted: 0,
        },
      ]);
    });

    it("drops the provenance lookup once the backfill completes", async () => {
      const result = await client.query({
        query: `SELECT toUInt32(count()) AS table_count FROM system.tables
          WHERE database = {database:String} AND name = 'activity_provenance_backfill'`,
        format: "JSONEachRow",
        query_params: { database },
      });

      expect(z.array(z.object({ table_count: z.number() })).parse(await result.json())).toEqual([
        { table_count: 0 },
      ]);
    });

    it("is idempotent when the whole migration is applied again", async () => {
      await applyMigrationStatements();

      expect(await readProvenance(outdoorActivityId)).toEqual([
        {
          activity_id: outdoorActivityId,
          provider_type: "road_cycling",
          modality: "road",
          is_deleted: 0,
        },
      ]);
    });
  });
});
