import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const groupId = "00000000-0000-4000-8000-000000000901";
const stravaActivityId = "00000000-0000-4000-8000-000000000101";
const pelotonActivityId = "00000000-0000-4000-8000-000000000102";

const identityRowsSchema = z.array(
  z.object({
    canonicalActivityId: z.string().uuid(),
    sourceActivityId: z.string().uuid(),
    sourceProvider: z.string(),
    sourceExternalId: z.string().nullable(),
    kind: z.string(),
    namespace: z.string().nullable(),
    value: z.string(),
    normalizedValue: z.string(),
    strength: z.string(),
    method: z.string(),
    sourceField: z.string().nullable(),
    isDeleted: z.coerce.number().int(),
  }),
);

describe("activity effort identity read model", () => {
  const database = `activity_effort_identity_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for activity effort identity tests");
    client = createClient({ url, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    await seedSchema(client, database);
  }, 120_000);

  beforeEach(async () => {
    for (const table of ["activity_source_records", "deduped_activity_members", "activity_effort_identity"]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("keeps exact identities from every source member of one canonical group", async () => {
    await seedActivitySourceRecords(client, database, [
      {
        activityId: stravaActivityId,
        providerId: "strava",
        externalId: "instance-1",
        raw: { routeId: "route-7" },
      },
      {
        activityId: pelotonActivityId,
        providerId: "peloton",
        externalId: "instance-2",
        raw: { pelotonClassId: "class-9" },
      },
    ]);

    await buildModel(client, database);

    expect(await readIdentityRows(client, database)).toEqual([
      expect.objectContaining({
        canonicalActivityId: groupId,
        sourceActivityId: stravaActivityId,
        sourceProvider: "strava",
        sourceExternalId: "instance-1",
        kind: "provider_route",
        namespace: "strava",
        value: "route-7",
        normalizedValue: "route-7",
        strength: "exact",
        sourceField: "routeId",
        isDeleted: 0,
      }),
      expect.objectContaining({
        canonicalActivityId: groupId,
        sourceActivityId: pelotonActivityId,
        sourceProvider: "peloton",
        sourceExternalId: "instance-2",
        kind: "provider_workout",
        namespace: "peloton",
        value: "class-9",
        normalizedValue: "class-9",
        strength: "exact",
        sourceField: "pelotonClassId",
        isDeleted: 0,
      }),
    ]);
  });

  it("keeps equal source names as weak evidence rather than exact reusable identities", async () => {
    await seedActivitySourceRecords(client, database, [
      { activityId: stravaActivityId, providerId: "strava", externalId: "instance-1", name: "FTP Test" },
      { activityId: pelotonActivityId, providerId: "peloton", externalId: "instance-2", name: " FTP  Test " },
    ]);

    await buildModel(client, database);

    expect(await readIdentityRows(client, database)).toEqual([
      expect.objectContaining({
        kind: "activity_name",
        namespace: "cycling",
        value: "FTP Test",
        normalizedValue: "ftp test",
        strength: "weak_similarity",
        sourceField: "name",
        isDeleted: 0,
      }),
      expect.objectContaining({
        kind: "activity_name",
        namespace: "cycling",
        value: "FTP  Test",
        normalizedValue: "ftp test",
        strength: "weak_similarity",
        sourceField: "name",
        isDeleted: 0,
      }),
    ]);
  });

  it("rebuilds a source identity when its raw evidence is refreshed late", async () => {
    await seedActivitySourceRecords(client, database, [
      {
        activityId: stravaActivityId,
        providerId: "strava",
        externalId: "instance-1",
        raw: { routeId: "route-7" },
      },
    ]);
    await buildModel(client, database);
    await client.command({
      query: `INSERT INTO ${database}.activity_source_records
        (activity_id, group_id, provider_id, user_id, external_id, canonical_type, name, raw,
         source_synced_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${stravaActivityId}', '${groupId}', 'strava', '${userId}', 'instance-1', 'cycling',
          NULL, '{"routeId":"route-8"}', toDateTime64('2026-09-01 12:05:00', 9, 'UTC'), 2, 0,
          toDateTime64('2026-09-01 12:05:00', 9, 'UTC'))`,
    });

    await buildModel(client, database, true);

    expect(await readIdentityRows(client, database)).toEqual([
      expect.objectContaining({ value: "route-7", isDeleted: 1 }),
      expect.objectContaining({ value: "route-8", isDeleted: 0 }),
    ]);
  });

  it("tombstones extracted identities when their source record is deleted", async () => {
    await seedActivitySourceRecords(client, database, [
      {
        activityId: stravaActivityId,
        providerId: "strava",
        externalId: "instance-1",
        raw: { routeId: "route-7" },
      },
    ]);
    await buildModel(client, database);
    await client.command({
      query: `INSERT INTO ${database}.activity_source_records
        (activity_id, group_id, provider_id, user_id, external_id, canonical_type, name, raw,
         source_synced_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${stravaActivityId}', '${groupId}', 'strava', '${userId}', 'instance-1', 'cycling',
          NULL, '{"routeId":"route-7"}', toDateTime64('2026-09-01 12:05:00', 9, 'UTC'), 2, 1,
          toDateTime64('2026-09-01 12:05:00', 9, 'UTC'))`,
    });

    await buildModel(client, database, true);

    expect(await readIdentityRows(client, database)).toEqual([
      expect.objectContaining({
        kind: "provider_route",
        sourceActivityId: stravaActivityId,
        value: "route-7",
        isDeleted: 1,
      }),
    ]);
  });
});

function renderModel(database: string, incremental: boolean): string {
  return renderDbtModelSql(readModelSql("activity_effort_identity.sql"), {
    isIncremental: incremental,
  })
    .replaceAll("{{ ref('activity_source_records') }}", `${database}.activity_source_records`)
    .replaceAll("{{ ref('deduped_activity_members') }}", `${database}.deduped_activity_members`)
    .replaceAll("{{ this }}", `${database}.activity_effort_identity`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function buildModel(
  client: ReturnType<typeof createClient>,
  database: string,
  incremental = false,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.activity_effort_identity ${renderModel(database, incremental)}`,
  });
}

async function readIdentityRows(
  client: ReturnType<typeof createClient>,
  database: string,
): Promise<z.infer<typeof identityRowsSchema>> {
  const result = await client.query({
    query: `SELECT
        toString(canonical_activity_id) AS canonicalActivityId,
        toString(source_activity_id) AS sourceActivityId,
        source_provider AS sourceProvider,
        source_external_id AS sourceExternalId,
        kind,
        namespace,
        value,
        normalized_value AS normalizedValue,
        strength,
        method,
        source_field AS sourceField,
        is_deleted AS isDeleted
      FROM ${database}.activity_effort_identity FINAL
      ORDER BY kind, sourceActivityId, normalizedValue`,
    format: "JSONEachRow",
  });
  return identityRowsSchema.parse(await result.json<unknown>());
}

async function seedActivitySourceRecords(
  client: ReturnType<typeof createClient>,
  database: string,
  rows: ReadonlyArray<{
    activityId: string;
    providerId: string;
    externalId: string;
    name?: string;
    raw?: Record<string, string>;
  }>,
): Promise<void> {
  for (const row of rows) {
    const name = row.name === undefined ? "NULL" : `'${row.name.replaceAll("'", "''")}'`;
    const raw = row.raw === undefined ? "NULL" : `'${JSON.stringify(row.raw).replaceAll("'", "''")}'`;
    await client.command({
      query: `INSERT INTO ${database}.activity_source_records
        (activity_id, group_id, provider_id, user_id, external_id, canonical_type, name, raw,
         source_synced_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${row.activityId}', '${groupId}', '${row.providerId}', '${userId}', '${row.externalId}',
          'cycling', ${name}, ${raw}, toDateTime64('2026-09-01 12:00:00', 9, 'UTC'), 1, 0,
          toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`,
    });
    await client.command({
      query: `INSERT INTO ${database}.deduped_activity_members
        (activity_id, user_id, member_activity_id, source_synced_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${groupId}', '${userId}', '${row.activityId}',
          toDateTime64('2026-09-01 12:00:00', 9, 'UTC'), 1, 0,
          toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`,
    });
  }
}

async function seedSchema(client: ReturnType<typeof createClient>, database: string): Promise<void> {
  const statements = [
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.activity_source_records (
      activity_id UUID,
      group_id Nullable(UUID),
      provider_id Nullable(String),
      user_id Nullable(UUID),
      external_id Nullable(String),
      canonical_type Nullable(String),
      name Nullable(String),
      raw Nullable(String),
      source_synced_at Nullable(DateTime64(9, 'UTC')),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`,
    `CREATE TABLE ${database}.deduped_activity_members (
      activity_id UUID,
      user_id UUID,
      member_activity_id UUID,
      source_synced_at Nullable(DateTime64(9, 'UTC')),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id)`,
    `CREATE TABLE ${database}.activity_effort_identity (
      user_id UUID,
      canonical_activity_id UUID,
      source_activity_id UUID,
      source_provider String,
      source_external_id Nullable(String),
      kind String,
      namespace String,
      value String,
      normalized_value String,
      display_name Nullable(String),
      strength String,
      method String,
      source_field String,
      evidence Map(String, String),
      source_refreshed_at DateTime64(9, 'UTC'),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, source_activity_id, kind, namespace, normalized_value, source_field)`,
  ];
  for (const query of statements) await client.command({ query });
}
