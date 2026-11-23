import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { CyclingProgressionRepository } from "./cycling-progression-repository.ts";

describe("CyclingProgressionRepository database semantics", () => {
  const analyticsDatabase = `cycling_progression_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const providerId = "cycling-progression-fixture";
  const selectedId = randomUUID();
  const priorId = randomUUID();
  const conflictUserId = randomUUID();
  const conflictSelectedId = randomUUID();
  const conflictMemberId = randomUUID();
  const conflictPriorId = randomUUID();
  const unlinkedUserId = randomUUID();
  const unlinkedSelectedId = randomUUID();
  const unlinkedPriorId = randomUUID();
  const staleUserId = randomUUID();
  const staleSelectedId = randomUUID();
  const stalePriorId = randomUUID();
  const removedMemberId = randomUUID();
  const normalizedUserId = randomUUID();
  const normalizedSelectedId = randomUUID();
  const normalizedPriorId = randomUUID();
  const offsetUserId = randomUUID();
  const offsetSelectedId = randomUUID();
  const offsetPriorId = randomUUID();
  const ninthUserId = randomUUID();
  const ninthSelectedId = randomUUID();
  const ninthPriorId = randomUUID();
  const ninthUnusableIds = Array.from({ length: 8 }, () => randomUUID());
  const timezoneBoundaryUserId = randomUUID();
  const tokyoSelectedId = randomUUID();
  const hawaiiLaterId = randomUUID();
  const selectedStart = "2026-06-01T12:00:00.000Z";
  const selectedEnd = "2026-06-01T12:10:00.000Z";
  const priorStart = "2026-05-25T12:00:00.000Z";
  const priorEnd = "2026-05-25T12:10:00.000Z";
  const fullAccess: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };
  const asClickHouseTime = (iso: string) => iso.replace("T", " ").replace("Z", "");
  const workEnd = (start: string) => new Date(Date.parse(start) + 300_000).toISOString();
  const staleAnalyticsStart = (start: string) =>
    new Date(Date.parse(start) + 350_000).toISOString();
  const ninthUnusableStart = (index: number) =>
    new Date(Date.parse("2026-05-31T20:00:00.000Z") - index * 3_600_000).toISOString();
  let postgres: TestContext;

  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      statement: string,
      params?: Record<string, unknown>,
    ): Promise<z.infer<TSchema>[]> {
      const result = await clickhouse.query({
        query: statement.replaceAll("analytics.", `${analyticsDatabase}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  const repository = (userId = TEST_USER_ID, accessWindow: AccessWindow = fullAccess) => {
    // findSensorWindow resolves the canonical window from Postgres alone.
    const activities = new ActivityRepository(postgres.db, userId, "UTC", accessWindow);
    return new CyclingProgressionRepository(
      postgres.db,
      store,
      userId,
      "UTC",
      accessWindow,
      activities,
    );
  };

  const seedActivity = async (
    owner: string,
    id: string,
    externalId: string,
    startedAt: string,
    endedAt: string,
    effort: number,
    groupId = id,
    localTime?: { source: string; startUtcOffsetMinutes: number; endUtcOffsetMinutes: number },
  ) => {
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        modality, started_at, ended_at, name, source_name, raw, perceived_exertion,
        local_time_source, start_utc_offset_minutes, end_utc_offset_minutes
      ) VALUES (
        ${id}::uuid, ${groupId}::uuid, ${providerId}, ${owner}::uuid, ${externalId},
        'cycling', 'cycling', 'indoor', ${startedAt}::timestamptz, ${endedAt}::timestamptz,
        'Ride', 'Wahoo', '{}'::jsonb, ${effort},
        ${localTime?.source ?? "unknown"},
        ${localTime?.startUtcOffsetMinutes ?? null},
        ${localTime?.endUtcOffsetMinutes ?? null}
      )
    `);
  };

  const seedWork = async (activityId: string, startedAt: string, segmentType?: string) => {
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity_interval (
        activity_id, interval_index, label, interval_type, started_at, ended_at,
        source_kind, source_provider, source_activity_id, work_recovery_kind, segment_type, raw
      ) VALUES (
        ${activityId}::uuid, 0, 'Work 1', 'workout_step', ${startedAt}::timestamptz,
        ${workEnd(startedAt)}::timestamptz, 'provider_recorded', 'wahoo',
        ${activityId}::uuid, ${segmentType ? null : "work"}, ${segmentType ?? null}, '{}'::jsonb
      )
    `);
  };

  const dedupedRow = (owner: string, id: string, startedAt: string, members: string[]) => ({
    activity_id: id,
    user_id: owner,
    started_at: asClickHouseTime(startedAt),
    member_activity_ids: members,
    refresh_version: 1,
    is_deleted: 0,
  });

  const powerSamples = (
    owner: string,
    id: string,
    startedAt: string,
    link: "linked" | "unlinked-work" | "stale-member-work",
    staleMemberId = id,
    measurementKind = "direct",
  ) =>
    Array.from({ length: 600 }, (_, elapsedSeconds) => ({
      activity_id: id,
      user_id: owner,
      recorded_at: asClickHouseTime(
        new Date(Date.parse(startedAt) + elapsedSeconds * 1000).toISOString(),
      ),
      channel: "power",
      scalar: 200,
      provider_id: "wahoo",
      device_id: "trainer",
      measurement_kind: measurementKind,
      member_activity_id:
        link === "linked" || elapsedSeconds >= 300
          ? id
          : link === "unlinked-work"
            ? null
            : staleMemberId,
      refresh_version: 1,
      is_deleted: 0,
    }));

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await ensureProvider(
      postgres.db,
      providerId,
      "Cycling progression fixture",
      undefined,
      TEST_USER_ID,
    );
    // activity_interval.source_provider has a provider FK; the samples report Wahoo power.
    await ensureProvider(postgres.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);
    await postgres.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES
        (${conflictUserId}::uuid, 'Cycling effort conflict fixture'),
        (${unlinkedUserId}::uuid, 'Cycling unlinked power fixture'),
        (${staleUserId}::uuid, 'Cycling stale membership fixture'),
        (${normalizedUserId}::uuid, 'Cycling class normalization fixture'),
        (${offsetUserId}::uuid, 'Cycling canonical start offset fixture'),
        (${ninthUserId}::uuid, 'Cycling ninth candidate fixture'),
        (${timezoneBoundaryUserId}::uuid, 'Cycling timezone boundary fixture')
      ON CONFLICT (id) DO NOTHING
    `);

    await seedActivity(TEST_USER_ID, selectedId, "selected-ride", selectedStart, selectedEnd, 5);
    await seedActivity(TEST_USER_ID, priorId, "prior-ride", priorStart, priorEnd, 5);
    await seedWork(selectedId, selectedStart);
    await seedWork(priorId, priorStart);

    // Conflicting non-null effort across current members of the selected canonical group.
    await seedActivity(
      conflictUserId,
      conflictSelectedId,
      "conflict-selected",
      selectedStart,
      selectedEnd,
      5,
    );
    await seedActivity(
      conflictUserId,
      conflictMemberId,
      "conflict-member",
      selectedStart,
      selectedEnd,
      3,
      conflictSelectedId,
    );
    await seedActivity(conflictUserId, conflictPriorId, "conflict-prior", priorStart, priorEnd, 5);
    await seedWork(conflictSelectedId, selectedStart);
    await seedWork(conflictPriorId, priorStart);

    await seedActivity(
      unlinkedUserId,
      unlinkedSelectedId,
      "unlinked-selected",
      selectedStart,
      selectedEnd,
      5,
    );
    await seedActivity(unlinkedUserId, unlinkedPriorId, "unlinked-prior", priorStart, priorEnd, 5);
    await seedWork(unlinkedSelectedId, selectedStart);
    await seedWork(unlinkedPriorId, priorStart);

    // Postgres no longer considers this member current; analytics still lists it.
    await seedActivity(
      staleUserId,
      staleSelectedId,
      "stale-selected",
      selectedStart,
      selectedEnd,
      5,
    );
    await seedActivity(
      staleUserId,
      removedMemberId,
      "stale-removed-member",
      selectedStart,
      selectedEnd,
      5,
      staleSelectedId,
    );
    await postgres.db.execute(
      sql`UPDATE fitness.activity SET deleted_at = NOW() WHERE id = ${removedMemberId}::uuid`,
    );
    await seedActivity(staleUserId, stalePriorId, "stale-prior", priorStart, priorEnd, 5);
    await seedWork(staleSelectedId, selectedStart);
    await seedWork(stalePriorId, priorStart);

    // The prior work class is mixed-case and padded; the SQL candidate predicate must normalize it.
    await seedActivity(
      normalizedUserId,
      normalizedSelectedId,
      "normalized-selected",
      selectedStart,
      selectedEnd,
      5,
    );
    await seedActivity(
      normalizedUserId,
      normalizedPriorId,
      "normalized-prior",
      priorStart,
      priorEnd,
      5,
    );
    await seedWork(normalizedSelectedId, selectedStart);
    await seedWork(normalizedPriorId, priorStart, " WOrK ");

    // Analytics still advertises a start 350 s after the current Postgres canonical start.
    await seedActivity(
      offsetUserId,
      offsetSelectedId,
      "offset-selected",
      selectedStart,
      selectedEnd,
      5,
    );
    await seedActivity(offsetUserId, offsetPriorId, "offset-prior", priorStart, priorEnd, 5);
    await seedWork(offsetSelectedId, selectedStart);
    await seedWork(offsetPriorId, priorStart);

    // Eight newer rides with estimated power fill one full keyset batch before the valid ninth.
    await seedActivity(
      ninthUserId,
      ninthSelectedId,
      "ninth-selected",
      selectedStart,
      selectedEnd,
      5,
    );
    await seedActivity(ninthUserId, ninthPriorId, "ninth-prior", priorStart, priorEnd, 5);
    await seedWork(ninthSelectedId, selectedStart);
    await seedWork(ninthPriorId, priorStart);
    for (const [index, id] of ninthUnusableIds.entries()) {
      const startedAt = ninthUnusableStart(index);
      await seedActivity(
        ninthUserId,
        id,
        `ninth-unusable-${index}`,
        startedAt,
        workEnd(startedAt),
        5,
      );
      await seedWork(id, startedAt);
    }

    // Regression: a physically later Hawaii ride (later UTC started_at) can have an earlier local
    // date than an earlier Tokyo ride. Local date alone would wrongly accept it as history.
    const tokyoStart = "2026-06-01T00:30:00.000Z"; // 2026-06-01 09:30 JST
    const tokyoEnd = "2026-06-01T00:40:00.000Z";
    const hawaiiStart = "2026-06-01T08:00:00.000Z"; // 2026-05-31 22:00 HST, later instant
    const hawaiiEnd = "2026-06-01T08:10:00.000Z";
    await seedActivity(
      timezoneBoundaryUserId,
      tokyoSelectedId,
      "tokyo-selected",
      tokyoStart,
      tokyoEnd,
      5,
      tokyoSelectedId,
      { source: "provider_offset", startUtcOffsetMinutes: 540, endUtcOffsetMinutes: 540 },
    );
    await seedActivity(
      timezoneBoundaryUserId,
      hawaiiLaterId,
      "hawaii-later-earlier-local-date",
      hawaiiStart,
      hawaiiEnd,
      5,
      hawaiiLaterId,
      { source: "provider_offset", startUtcOffsetMinutes: -600, endUtcOffsetMinutes: -600 },
    );
    await seedWork(tokyoSelectedId, tokyoStart);
    await seedWork(hawaiiLaterId, hawaiiStart);

    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.deduped_activities (
        activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'),
        member_activity_ids Array(UUID), refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_sensor_sample (
        activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'),
        channel LowCardinality(String), scalar Nullable(Float64),
        provider_id Nullable(String), device_id Nullable(String),
        measurement_kind LowCardinality(String), member_activity_id Nullable(UUID),
        refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_effort_identity (
        user_id UUID, canonical_activity_id UUID, source_activity_id UUID,
        source_provider String, source_external_id Nullable(String),
        kind String, namespace Nullable(String), value String, normalized_value String,
        display_name Nullable(String), strength String, method String,
        source_field Nullable(String), evidence String, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree ORDER BY (user_id, source_activity_id, kind, value)`,
    });

    await clickhouse.insert({
      table: `${analyticsDatabase}.deduped_activities`,
      format: "JSONEachRow",
      values: [
        dedupedRow(TEST_USER_ID, selectedId, selectedStart, [selectedId]),
        dedupedRow(TEST_USER_ID, priorId, priorStart, [priorId]),
        dedupedRow(conflictUserId, conflictSelectedId, selectedStart, [
          conflictMemberId,
          conflictSelectedId,
        ]),
        dedupedRow(conflictUserId, conflictPriorId, priorStart, [conflictPriorId]),
        dedupedRow(unlinkedUserId, unlinkedSelectedId, selectedStart, [unlinkedSelectedId]),
        dedupedRow(unlinkedUserId, unlinkedPriorId, priorStart, [unlinkedPriorId]),
        dedupedRow(staleUserId, staleSelectedId, selectedStart, [staleSelectedId, removedMemberId]),
        dedupedRow(staleUserId, stalePriorId, priorStart, [stalePriorId]),
        dedupedRow(normalizedUserId, normalizedSelectedId, selectedStart, [normalizedSelectedId]),
        dedupedRow(normalizedUserId, normalizedPriorId, priorStart, [normalizedPriorId]),
        dedupedRow(offsetUserId, offsetSelectedId, staleAnalyticsStart(selectedStart), [
          offsetSelectedId,
        ]),
        dedupedRow(offsetUserId, offsetPriorId, staleAnalyticsStart(priorStart), [offsetPriorId]),
        dedupedRow(ninthUserId, ninthSelectedId, selectedStart, [ninthSelectedId]),
        dedupedRow(ninthUserId, ninthPriorId, priorStart, [ninthPriorId]),
        ...ninthUnusableIds.map((id, index) =>
          dedupedRow(ninthUserId, id, ninthUnusableStart(index), [id]),
        ),
        dedupedRow(timezoneBoundaryUserId, tokyoSelectedId, "2026-06-01T00:30:00.000Z", [
          tokyoSelectedId,
        ]),
        dedupedRow(timezoneBoundaryUserId, hawaiiLaterId, "2026-06-01T08:00:00.000Z", [
          hawaiiLaterId,
        ]),
      ],
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_sensor_sample`,
      format: "JSONEachRow",
      values: [
        ...powerSamples(TEST_USER_ID, selectedId, selectedStart, "linked"),
        ...powerSamples(TEST_USER_ID, priorId, priorStart, "linked"),
        ...powerSamples(conflictUserId, conflictSelectedId, selectedStart, "linked"),
        ...powerSamples(conflictUserId, conflictPriorId, priorStart, "linked"),
        ...powerSamples(unlinkedUserId, unlinkedSelectedId, selectedStart, "unlinked-work"),
        ...powerSamples(unlinkedUserId, unlinkedPriorId, priorStart, "unlinked-work"),
        ...powerSamples(
          staleUserId,
          staleSelectedId,
          selectedStart,
          "stale-member-work",
          removedMemberId,
        ),
        ...powerSamples(staleUserId, stalePriorId, priorStart, "linked"),
        ...powerSamples(normalizedUserId, normalizedSelectedId, selectedStart, "linked"),
        ...powerSamples(normalizedUserId, normalizedPriorId, priorStart, "linked"),
        ...powerSamples(offsetUserId, offsetSelectedId, selectedStart, "linked"),
        ...powerSamples(offsetUserId, offsetPriorId, priorStart, "linked"),
        ...powerSamples(ninthUserId, ninthSelectedId, selectedStart, "linked"),
        ...powerSamples(ninthUserId, ninthPriorId, priorStart, "linked"),
        ...ninthUnusableIds.flatMap((id, index) =>
          powerSamples(ninthUserId, id, ninthUnusableStart(index), "linked", id, "estimated"),
        ),
        ...powerSamples(
          timezoneBoundaryUserId,
          tokyoSelectedId,
          "2026-06-01T00:30:00.000Z",
          "linked",
        ),
        ...powerSamples(
          timezoneBoundaryUserId,
          hawaiiLaterId,
          "2026-06-01T08:00:00.000Z",
          "linked",
        ),
      ],
    });
  });

  afterAll(async () => {
    // Each resource is released independently so one failure cannot leak another; all errors are
    // surfaced together after drop-then-close and Postgres cleanup have each been attempted.
    const errors: unknown[] = [];
    try {
      await postgres?.cleanup();
    } catch (error) {
      errors.push(error);
    }
    try {
      await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    } catch (error) {
      errors.push(error);
    }
    try {
      await clickhouse.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Cycling progression fixture teardown failed");
    }
  });

  it("returns the eligible pair with source-backed work evidence from both engines", async () => {
    const result = await repository().getCyclingProgression(selectedId);
    expect(result).toMatchObject({
      status: "ready",
      basis: "recorded_work_protocol",
      comparison: { intervalCount: 1 },
      rides: [
        {
          role: "selected",
          activityId: selectedId,
          date: "2026-06-01",
          sessionEffort: 5,
          modality: "indoor",
          intervalCount: 1,
          intervals: [
            expect.objectContaining({
              index: 1,
              workDurationSeconds: 300,
              meanPowerWatts: 200,
              powerCoveragePct: 100,
              sourceProvider: "wahoo",
              sourceActivityId: selectedId,
            }),
          ],
          powerProvenance: {
            measurementKind: "direct",
            providers: ["wahoo"],
            devices: ["trainer"],
          },
        },
        {
          role: "comparison",
          activityId: priorId,
          date: "2026-05-25",
          sessionEffort: 5,
          modality: "indoor",
        },
      ],
    });
    expect(result?.comparison.largestDurationDifferencePct).toBeCloseTo(0, 5);
    expect(result?.comparison.largestMeanPowerDifferencePct).toBeCloseTo(0, 5);
  });

  it("excludes activities outside the caller's ownership or entitlement window", async () => {
    await expect(repository(randomUUID()).getCyclingProgression(selectedId)).resolves.toBeNull();
    const unrelated: AccessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2030-01-01",
      endDateExclusive: "2031-01-01",
    };
    await expect(
      repository(TEST_USER_ID, unrelated).getCyclingProgression(selectedId),
    ).resolves.toBeNull();
    const selectedOnly: AccessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-06-01",
      endDateExclusive: "2026-06-02",
    };
    await expect(
      repository(TEST_USER_ID, selectedOnly).getCyclingProgression(selectedId),
    ).resolves.toBeNull();
  });

  it("excludes a selected ride whose current members disagree on effort", async () => {
    await expect(
      repository(conflictUserId).getCyclingProgression(conflictSelectedId),
    ).resolves.toBeNull();
  });

  it("does not count unlinked key power even when time overlap matches the work window", async () => {
    await expect(
      repository(unlinkedUserId).getCyclingProgression(unlinkedSelectedId),
    ).resolves.toBeNull();
  });

  it("rejects power linked only to a member that Postgres no longer authorizes", async () => {
    await expect(
      repository(staleUserId).getCyclingProgression(staleSelectedId),
    ).resolves.toBeNull();
  });

  it("normalizes mixed-case padded work classes in the candidate query", async () => {
    const result = await repository(normalizedUserId).getCyclingProgression(normalizedSelectedId);
    expect(result?.status).toBe("ready");
    expect(result?.rides[1]?.activityId).toBe(normalizedPriorId);
  });

  it("uses the current Postgres canonical start when the analytics start is stale", async () => {
    const result = await repository(offsetUserId).getCyclingProgression(offsetSelectedId);
    expect(result?.status).toBe("ready");
    expect(result?.comparison.largestMeanPowerDifferencePct).toBeCloseTo(0, 5);
    expect(result?.rides[0]?.intervals[0]?.powerCoveragePct).toBe(100);
  });

  it("scans past a full keyset batch to a ninth usable candidate", async () => {
    const result = await repository(ninthUserId).getCyclingProgression(ninthSelectedId);
    expect(result?.status).toBe("ready");
    expect(result?.rides[1]?.activityId).toBe(ninthPriorId);
  });

  it("rejects a physically later ride whose earlier local date would otherwise pass", async () => {
    // Tokyo 19:00 JST is earlier on the clock than Hawaii 08:00 HST on the same local calendar day,
    // but it is 8 hours earlier in UTC. The local-date gate alone would wrongly accept Hawaii.
    const result = await repository(timezoneBoundaryUserId).getCyclingProgression(tokyoSelectedId);
    expect(result).toBeNull();
  });
});
