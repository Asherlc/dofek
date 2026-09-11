import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { RepeatedEffortsRepository } from "./repeated-efforts-repository.ts";

describe("RepeatedEffortsRepository database queries", () => {
  const database = `repeated_efforts_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const otherUser = randomUUID();
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const [first, second, third, deleted, invalid, outside, merged] = ids;
  let postgres: TestContext;
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      query: string,
      params?: Record<string, unknown>,
    ): Promise<z.infer<TSchema>[]> {
      const result = await clickhouse.query({
        query: query.replaceAll("analytics.", `${database}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };
  const input = { startDate: "2026-01-01", endDate: "2026-01-31" };
  const repository = () =>
    new RepeatedEffortsRepository(postgres.db, store, TEST_USER_ID, "America/Los_Angeles");
  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    const tables = [
      [
        "deduped_activities",
        `activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')), canonical_type String, modality Nullable(String), name Nullable(String), member_activity_ids Array(UUID), source_providers Array(String)`,
        "user_id, activity_id",
      ],
      [
        "activity_effort_identity",
        `user_id UUID, canonical_activity_id UUID, source_activity_id UUID, source_provider String, source_external_id Nullable(String), kind String, namespace String, value String, normalized_value String, display_name Nullable(String), strength String, method String, source_field String, evidence Map(String,String)`,
        "user_id, source_activity_id, kind, namespace, normalized_value, source_field",
      ],
      [
        "activity_source_records",
        `user_id UUID, activity_id UUID, provider_id String, external_id Nullable(String)`,
        "user_id, activity_id",
      ],
      [
        "activity_route_identity",
        `user_id UUID, canonical_activity_id UUID, points Array(Tuple(Float64,Float64)), route_distance_meters Nullable(Float64), elevation_profile Array(Float64), coverage_pct Nullable(Float64), largest_gap_seconds Nullable(Float64), geometry_status String, source_providers Array(String), source_devices Array(String)`,
        "user_id, canonical_activity_id",
      ],
    ];
    for (const [table, columns, order] of tables) {
      await clickhouse.command({
        query: `CREATE TABLE ${database}.${table} (${columns}, refresh_version UInt64, is_deleted UInt8) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (${order})`,
      });
    }
    const activities = [first, second, third, deleted, invalid, outside].map(
      (activityId, index) => ({
        activity_id: activityId,
        user_id: TEST_USER_ID,
        started_at: index === 5 ? "2026-02-01 08:00:00" : `2026-01-0${index + 1} 08:00:00`,
        ended_at:
          index === 4
            ? "2026-01-05 07:59:00"
            : index === 5
              ? "2026-02-01 09:00:00"
              : `2026-01-0${index + 1} 09:00:00`,
        canonical_type: "cycling",
        modality: index === 2 ? "indoor" : "outdoor",
        name: "Tempo",
        member_activity_ids: index === 0 ? [activityId, merged] : [activityId],
        source_providers: index === 0 ? ["garmin", "apple_health"] : ["garmin"],
        refresh_version: 1,
        is_deleted: 0,
      }),
    );
    await clickhouse.insert({
      table: `${database}.deduped_activities`,
      values: [
        ...activities,
        { ...activities[3], refresh_version: 2, is_deleted: 1 },
        { ...activities[0], user_id: otherUser },
      ],
      format: "JSONEachRow",
    });
    const identities = [first, second, third, deleted, invalid, outside].map((activityId) => ({
      user_id: TEST_USER_ID,
      canonical_activity_id: activityId,
      source_activity_id: activityId,
      source_provider: "garmin",
      source_external_id: `instance-${activityId}`,
      kind: "provider_workout",
      namespace: "garmin",
      value: "template-1",
      normalized_value: "template-1",
      display_name: "Tempo",
      strength: "exact",
      method: "explicit",
      source_field: "templateId",
      evidence: { original: "template-1" },
      refresh_version: 1,
      is_deleted: 0,
    }));
    await clickhouse.insert({
      table: `${database}.activity_effort_identity`,
      values: [
        ...identities,
        ...identities.map((row) => ({
          ...row,
          kind: "activity_name",
          value: "Tempo",
          normalized_value: "tempo",
          strength: "weak_similarity",
          source_field: "name",
        })),
        ...identities
          .slice(0, 2)
          .map((row) => ({ ...row, value: "stale-template", normalized_value: "stale-template" })),
        ...identities.slice(0, 2).map((row) => ({
          ...row,
          value: "stale-template",
          normalized_value: "stale-template",
          refresh_version: 2,
          is_deleted: 1,
        })),
        ...identities.slice(0, 2).map((row) => ({
          ...row,
          user_id: otherUser,
          value: "other-secret",
          normalized_value: "other-secret",
        })),
      ],
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${database}.activity_source_records`,
      values: [
        ...ids.map((activityId) => ({
          user_id: TEST_USER_ID,
          activity_id: activityId,
          provider_id: activityId === merged ? "apple_health" : "garmin",
          external_id: `source-${activityId}`,
          refresh_version: 1,
          is_deleted: 0,
        })),
        {
          user_id: otherUser,
          activity_id: merged,
          provider_id: "private-provider",
          external_id: "private-record",
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
    await clickhouse.insert({
      table: `${database}.activity_route_identity`,
      values: [first, second].map((activityId) => ({
        user_id: TEST_USER_ID,
        canonical_activity_id: activityId,
        points: [
          [40, -74],
          [40.01, -74],
        ],
        route_distance_meters: 1112,
        elevation_profile: [],
        coverage_pct: 100,
        largest_gap_seconds: 1,
        geometry_status: "available",
        source_providers: activityId === first ? ["garmin"] : ["strava"],
        source_devices: activityId === first ? ["Edge 1050"] : ["iPhone"],
        refresh_version: 1,
        is_deleted: 0,
      })),
      format: "JSONEachRow",
    });
    await postgres.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${otherUser}, 'Other discovery user')`,
    );
    for (const activityId of [first, second]) {
      await postgres.db.execute(
        sql`INSERT INTO fitness.activity_group (id, user_id) VALUES (${activityId}, ${TEST_USER_ID})`,
      );
    }
    const groupId = randomUUID();
    await postgres.db.execute(
      sql`INSERT INTO fitness.effort_equivalence_group (id, user_id, display_name, effort_kind, notes) VALUES (${groupId}, ${TEST_USER_ID}, 'Steady benchmark', 'user_defined_benchmark', 'Same route')`,
    );
    for (const activityId of [first, second]) {
      await postgres.db.execute(
        sql`INSERT INTO fitness.effort_equivalence_group_member (group_id, user_id, canonical_activity_id, inclusion_note) VALUES (${groupId}, ${TEST_USER_ID}, ${activityId}, 'Same protocol')`,
      );
    }
    await postgres.db.execute(
      sql`INSERT INTO fitness.effort_equivalence_group (user_id, display_name, effort_kind) VALUES (${otherUser}, 'Private benchmark', 'user_defined_benchmark')`,
    );
  }, 60000);
  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await clickhouse.close();
    await postgres?.cleanup();
  });

  it("executes current identity and source queries with user/date/deletion scoping", async () => {
    const result = await repository().find({ ...input, effortKind: "provider_workout" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      strength: "exact",
      repetitionCount: 3,
      canonicalActivityIds: [first, second, third].sort(),
      firstOccurrence: "2026-01-01T08:00:00.000Z",
    });
    expect(result.groups[0]?.sourceEvidence).toContainEqual({
      canonicalActivityId: first,
      sourceActivityId: merged,
      provider: "apple_health",
      externalId: `source-${merged}`,
    });
    expect(result.groups[0]?.identityEvidence).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("stale-template");
  });
  it("executes filters before repetition counts, including a local-calendar date boundary", async () => {
    const outdoors = await repository().find({
      ...input,
      effortKind: "provider_workout",
      modalities: ["outdoor"],
      providers: ["garmin"],
    });
    expect(outdoors.groups[0]?.repetitionCount).toBe(2);
    expect(
      (
        await repository().find({
          ...input,
          effortKind: "provider_workout",
          providers: ["apple_health"],
        })
      ).groups,
    ).toEqual([]);
    expect((await repository().find({ ...input, canonicalTypes: ["running"] })).groups).toEqual([]);
    expect(
      (
        await repository().find({
          ...input,
          startDate: "2026-01-02",
          effortKind: "provider_workout",
        })
      ).groups[0]?.canonicalActivityIds,
    ).toEqual([second, third].sort());
  });
  it("preserves per-member geometry provenance when a merged activity has GPS from one source", async () => {
    const result = await repository().find({ ...input, effortKind: "canonical_route" });
    expect(result.groups[0]).toMatchObject({ strength: "strong_inferred", repetitionCount: 2 });
    const evidence = result.groups[0]?.identityEvidence ?? [];
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalActivityId: first,
          provider: "garmin",
          evidence: expect.objectContaining({
            sourceProviders: ["garmin"],
            sourceDevices: ["Edge 1050"],
          }),
        }),
      ]),
    );
    for (const routeEvidence of evidence) {
      expect(routeEvidence).toMatchObject({
        provider: expect.any(String),
        evidence: expect.objectContaining({
          matched: true,
          direction: "forward",
          sourceProviders: expect.any(Array),
          sourceDevices: expect.any(Array),
          anchorSourceProviders: expect.any(Array),
          anchorSourceDevices: expect.any(Array),
        }),
      });
    }
    const anchor = evidence.find(
      (routeEvidence) =>
        routeEvidence.evidence.anchorCanonicalActivityId === routeEvidence.canonicalActivityId,
    );
    expect(anchor?.evidence).toMatchObject({
      sourceProviders: anchor?.evidence.anchorSourceProviders,
      sourceDevices: anchor?.evidence.anchorSourceDevices,
    });
  });
  it("executes Postgres benchmark memberships against stable canonical groups", async () => {
    const result = await repository().find({ ...input, effortKind: "user_defined_benchmark" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      displayName: "Steady benchmark",
      strength: "caller_asserted",
      repetitionCount: 2,
    });
    expect(result.groups[0]?.identityEvidence[0]?.evidence).toEqual({
      notes: "Same route",
      inclusionNote: "Same protocol",
    });
    const other = new RepeatedEffortsRepository(postgres.db, store, otherUser, "UTC");
    expect((await other.find({ ...input, effortKind: "user_defined_benchmark" })).groups).toEqual(
      [],
    );
  });
  it("returns separately labeled weak candidates only on opt-in", async () => {
    expect((await repository().find({ ...input, effortKind: "activity_name" })).groups).toEqual([]);
    const weak = await repository().find({
      ...input,
      effortKind: "activity_name",
      equivalenceStrength: "weak",
    });
    expect(weak.groups[0]).toMatchObject({ strength: "weak_similarity", repetitionCount: 2 });
  });
  it("paginates after filtering and rejects a cursor reused by another user", async () => {
    const firstPage = await repository().find({ ...input, limit: 1 });
    expect(firstPage.groups).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const nextPage = await repository().find({ ...input, limit: 1, cursor: firstPage.nextCursor });
    expect(nextPage.groups).toHaveLength(1);
    expect(nextPage.groups[0]?.effortId).not.toBe(firstPage.groups[0]?.effortId);
    expect(nextPage.nextCursor).toBeNull();
    const other = new RepeatedEffortsRepository(
      postgres.db,
      store,
      otherUser,
      "America/Los_Angeles",
    );
    await expect(other.find({ ...input, cursor: firstPage.nextCursor })).rejects.toThrow(/cursor/i);
  });
});
