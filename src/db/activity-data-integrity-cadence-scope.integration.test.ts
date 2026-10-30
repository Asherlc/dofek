import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readActivityIntegrityCadenceVersions,
  resolveActivityIntegrityCadenceScope,
  verifyActivityIntegrityCadenceBatch,
} from "./activity-data-integrity-cadence-scope.ts";

const userId = randomUUID();
const foreignUserId = randomUUID();
const database = `cadence_scope_${randomUUID().replaceAll("-", "")}`;
const environmentKeys = ["DBT_CLICKHOUSE_SCHEMA", "DBT_POSTGRES_FITNESS_SOURCE_SCHEMA"] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
let client: ReturnType<typeof createClient>;

describe("activity integrity canonical cadence scope", () => {
  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required for cadence scope integration tests");
    client = createClient({ url });
    for (const key of environmentKeys) process.env[key] = database;
  });
  beforeEach(async () => {
    for (const query of [
      `DROP DATABASE IF EXISTS ${database} SYNC`,
      `CREATE DATABASE ${database}`,
      `CREATE TABLE ${database}.activity (id UUID, group_id Nullable(UUID), user_id UUID, provider_id String, raw String, _peerdb_is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,id)`,
      `CREATE TABLE ${database}.activity_source_records (activity_id UUID,group_id Nullable(UUID),user_id UUID,is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,activity_id)`,
      `CREATE TABLE ${database}.activity_duplicate_groups (activity_id UUID,group_id Nullable(UUID),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY activity_id`,
      `CREATE TABLE ${database}.deduped_activities (activity_id UUID,user_id UUID,member_activity_ids Array(UUID),canonical_type String,is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,activity_id)`,
      `CREATE TABLE ${database}.deduped_activity_members (activity_id UUID,member_activity_id UUID,user_id UUID,is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,member_activity_id)`,
    ])
      await client.command({ query });
  });
  afterAll(async () => {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client?.close();
  });

  it("retains provider, source, deleted canonical/member and exact HealthKit sibling aliases", async () => {
    const requested = randomUUID(),
      mirrorGroup = randomUUID(),
      mirrorMember = randomUUID();
    const persistedGroup = randomUUID(),
      memberGroup = randomUUID(),
      memberOnly = randomUUID();
    const sourceGroup = randomUUID(),
      historicalGroup = randomUUID(),
      historicalMember = randomUUID();
    const sibling = randomUUID(),
      siblingGroup = randomUUID(),
      foreign = randomUUID(),
      cdcDeleted = randomUUID();
    const raw = (sync: string) =>
      JSON.stringify({ metadata: { HKMetadataKeySyncIdentifier: sync } });
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [
        { id: requested, group_id: mirrorGroup, user_id: userId, provider_id: "wahoo", raw: "{}" },
        {
          id: mirrorMember,
          group_id: mirrorGroup,
          user_id: userId,
          provider_id: "apple_health",
          raw: raw(" sync "),
        },
        {
          id: sibling,
          group_id: siblingGroup,
          user_id: userId,
          provider_id: "apple_health",
          raw: raw("sync"),
        },
        {
          id: foreign,
          group_id: foreign,
          user_id: foreignUserId,
          provider_id: "apple_health",
          raw: raw("sync"),
        },
        {
          id: cdcDeleted,
          group_id: cdcDeleted,
          user_id: userId,
          provider_id: "apple_health",
          raw: raw("sync"),
          _peerdb_is_deleted: 1,
        },
      ],
    });
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [{ activity_id: requested, group_id: sourceGroup, user_id: userId, is_deleted: 1 }],
    });
    await client.insert({
      table: `${database}.activity_duplicate_groups`,
      format: "JSONEachRow",
      values: [{ activity_id: requested, group_id: persistedGroup, is_deleted: 1 }],
    });
    await client.insert({
      table: `${database}.deduped_activity_members`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: memberGroup,
          member_activity_id: historicalMember,
          user_id: userId,
          is_deleted: 1,
        },
        {
          activity_id: memberGroup,
          member_activity_id: memberOnly,
          user_id: userId,
          is_deleted: 1,
        },
      ],
    });
    await client.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: historicalGroup,
          user_id: userId,
          member_activity_ids: [requested, historicalMember],
          canonical_type: "running",
          is_deleted: 1,
        },
        {
          activity_id: siblingGroup,
          user_id: userId,
          member_activity_ids: [sibling],
          canonical_type: "running",
          is_deleted: 0,
        },
      ],
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_step_cadence_rows (user_id UUID,activity_id UUID,refresh_version UInt64,is_deleted UInt8) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    });
    await client.insert({
      table: `${database}.activity_step_cadence_rows`,
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: historicalGroup,
          refresh_version: "9007199254740993",
          is_deleted: 0,
        },
        {
          user_id: foreignUserId,
          activity_id: siblingGroup,
          refresh_version: "18446744073709551615",
          is_deleted: 0,
        },
      ],
    });
    const result = await resolveActivityIntegrityCadenceScope(client, {
      userId,
      activityIds: [requested],
    });
    expect(result).toEqual({
      activityIds: [
        requested,
        mirrorGroup,
        mirrorMember,
        sourceGroup,
        persistedGroup,
        memberGroup,
        memberOnly,
        historicalGroup,
        historicalMember,
        sibling,
        siblingGroup,
      ].sort(),
      cadenceActivityIds: [historicalGroup, siblingGroup].sort(),
    });
    expect(
      await readActivityIntegrityCadenceVersions(client, {
        userId,
        activityIds: result.cadenceActivityIds,
      }),
    ).toEqual(new Map([[historicalGroup, 9007199254740993n]]));
  });
  it("keeps an absent cadence target empty while retaining the ordinary identity scope", async () => {
    const id = randomUUID();
    expect(
      await resolveActivityIntegrityCadenceScope(client, { userId, activityIds: [id] }),
    ).toEqual({ activityIds: [id], cadenceActivityIds: [] });
    expect(
      await readActivityIntegrityCadenceVersions(client, { userId, activityIds: [id] }),
    ).toEqual(new Map());
  });
  it("fails on missing upstream prerequisites instead of returning an empty successful scope", async () => {
    await client.command({ query: `DROP TABLE ${database}.deduped_activity_members SYNC` });
    await expect(
      resolveActivityIntegrityCadenceScope(client, { userId, activityIds: [randomUUID()] }),
    ).rejects.toThrow();
  });
  it("verifies lossless one-unit UInt64 advancement including tombstones and rejects stale/missing keys", async () => {
    const activityId = randomUUID(),
      missing = randomUUID();
    await client.command({
      query: `CREATE TABLE ${database}.activity_step_cadence_rows (user_id UUID,activity_id UUID,refresh_version UInt64,is_deleted UInt8) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    });
    const scope = { userId, activityIds: [activityId] };
    await client.insert({
      table: `${database}.activity_step_cadence_rows`,
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          refresh_version: "9007199254740993",
          is_deleted: 0,
        },
      ],
    });
    const before = await readActivityIntegrityCadenceVersions(client, scope);
    await expect(verifyActivityIntegrityCadenceBatch(client, scope, before)).rejects.toThrow(
      "missing or stale key",
    );
    await client.insert({
      table: `${database}.activity_step_cadence_rows`,
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          refresh_version: "9007199254740994",
          is_deleted: 1,
        },
      ],
    });
    await expect(
      verifyActivityIntegrityCadenceBatch(client, scope, before),
    ).resolves.toBeUndefined();
    await expect(
      verifyActivityIntegrityCadenceBatch(client, { userId, activityIds: [missing] }, new Map()),
    ).rejects.toThrow(missing);
    await client.command({ query: `DROP TABLE ${database}.activity_step_cadence_rows SYNC` });
    await expect(
      verifyActivityIntegrityCadenceBatch(client, { userId, activityIds: [] }, new Map()),
    ).rejects.toThrow("did not create");
  });
  it("does not expand absent or whitespace-only sync identifiers", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: ids.map((id, index) => ({
        id,
        group_id: id,
        user_id: userId,
        provider_id: "apple_health",
        raw:
          index === 2 ? "{}" : JSON.stringify({ metadata: { HKMetadataKeySyncIdentifier: "   " } }),
      })),
    });
    const requested = ids[0];
    if (!requested) throw new Error("Missing requested fixture identity");
    expect(
      await resolveActivityIntegrityCadenceScope(client, { userId, activityIds: [requested] }),
    ).toEqual({ activityIds: [requested], cadenceActivityIds: [] });
  });
});
