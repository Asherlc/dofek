import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { readGhostAltitudeWindowProof } from "dofek/db/activity-ghost-scalar-sample";
import { readGhostMapLabelConsent } from "dofek/db/ghost-map-label-consent";
import {
  getGhostTrackEvidence,
  ghostRouteLabelsSourceVersion,
} from "dofek/db/ghost-track-evidence";
import { enqueueGhostRouteClimbs } from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { ghostRouteClimbsCacheKey } from "dofek/lib/ghost-route-climbs-cache";
import { ghostRouteLabelsCacheKey } from "dofek/lib/ghost-route-labels-cache";
import {
  ghostRecordedSectionId,
  preparedGhostSectionsSchema,
  preparedGhostTrackStampSchema,
} from "dofek/lib/ghost-route-section-results";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryOwner } from "../../../../src/analytics/analytics-query-owner.ts";
import { recordedGhostRouteChunks } from "../../../../src/analytics/ghost-route-matching.ts";
import { runGhostSessionHistory } from "../../../../src/analytics/ghost-session-history-runner.ts";
import { getGhostTrack } from "../../../../src/db/activity-ghost-track.ts";
import {
  createActivityLocationMemberChangeSql,
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "../../../../src/db/activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "../../../../src/db/activity-payload-dbt-source-test-helpers.ts";
import { buildIncrementalDedupedSensorBaseTableStatements } from "../../../../src/db/clickhouse-deduped-sensor.ts";
import { createMigration as createScalarAuditMigration } from "../../../../src/db/clickhouse-migrations/0123_ghost_session_scalar_audit.ts";
import { createGhostSessionHistorySql } from "../../../../src/db/ghost-session-history-schema.ts";
import { createGhostSessionPageSql } from "../../../../src/db/ghost-session-result-schema.ts";
import { createGhostTrackIndexSql } from "../../../../src/db/ghost-track-index-schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { appRouter } from "../router.ts";

vi.mock("dofek/jobs/queues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/jobs/queues")>()),
  enqueueGhostRouteClimbs: vi.fn(),
  enqueueGhostRouteLabels: vi.fn(),
}));

const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const aliasId = randomUUID();
const siblingMemberId = randomUUID();
const anchorSiblingMemberId = randomUUID();
const providerId = "ghost_serving_fixture";
const sourceWatermark = "2026-10-11 10:00:00.123456789";
const laterWatermark = "2026-10-12 10:00:00.123456789";
const degreesPerMeter = 180 / (Math.PI * 6_371_000);

function recording(day: string, secondsBetweenPositions: number) {
  return { activityId: randomUUID(), memberId: randomUUID(), day, secondsBetweenPositions };
}
type Recording = ReturnType<typeof recording>;

function time({ day }: Recording, seconds: number) {
  return new Date(Date.parse(`${day}T10:00:00Z`) + seconds * 1_000)
    .toISOString()
    .replace(".000Z", ".123456Z");
}

const anchor = recording("2026-10-10", 2);
const newer = recording("2026-10-09", 4);
const older = recording("2026-10-08", 3);
const hiddenHistory: AccessWindow = {
  kind: "limited",
  paid: false,
  reason: "free_recent_week",
  startDate: "2026-10-09",
  endDateExclusive: "2026-10-12",
};

describe("protected Ghost Sessions with native visibility and evidence", () => {
  const database = `ghost_serving_${randomUUID().replaceAll("-", "")}`;
  const scope = (query: string) => query.replaceAll(/(?:analytics|ingest)\./g, `${database}.`);
  let postgres: TestContext;
  let clickhouse: ReturnType<typeof createClient>;

  const nativeClient: AnalyticsQueryOwner["client"] = {
    query: (options) => clickhouse.query({ ...options, query: scope(options.query) }),
    command: (options) => clickhouse.command({ ...options, query: scope(options.query) }),
    insert: (options) => clickhouse.insert({ ...options, table: scope(options.table) }),
  };

  function caller(userId = ownerId, accessWindow?: AccessWindow) {
    return appRouter.createCaller({
      userId,
      timezone: "UTC",
      accessWindow,
      db: postgres.db,
      sensorStore: new ClickHouseActivitySensorStore(nativeClient),
      accountErasureRestoreLedger: {
        findIntent: async () => null,
        listIntentReferences: async () => [],
        listIntentsForIdentities: async () => [],
        recordIntent: async () => undefined,
      },
    }).ghostSessions;
  }

  async function insertPostgresMember(fixture: Recording, memberId = fixture.memberId) {
    const startedAt = time(fixture, 0);
    const endedAt = time(fixture, fixture.secondsBetweenPositions * 20);
    await postgres.db.execute(sql`INSERT INTO fitness.activity (
      id, group_id, provider_id, user_id, external_id, canonical_type, provider_type, modality,
      started_at, ended_at, name
    ) VALUES (${memberId}, ${fixture.activityId}, ${providerId}, ${ownerId},
      ${memberId}, 'cycling', 'ride', 'road', ${startedAt}, ${endedAt}, 'Private fixture title')`);
  }

  async function seedTrack(fixture: Recording) {
    const startedAt = time(fixture, 0);
    const endedAt = time(fixture, fixture.secondsBetweenPositions * 20);
    await insertPostgresMember(fixture);
    await clickhouse.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: fixture.memberId,
          group_id: fixture.activityId,
          user_id: ownerId,
          provider_id: providerId,
          canonical_type: "cycling",
          modality: "road",
          started_at: startedAt,
          ended_at: endedAt,
          source_synced_at: sourceWatermark,
          refresh_version: 1,
        },
      ],
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    await clickhouse.insert({
      table: `${database}.activity_ghost_location_sample`,
      format: "JSONEachRow",
      values: Array.from({ length: 21 }, (_, index) => ({
        user_id: ownerId,
        activity_id: fixture.activityId,
        member_activity_id: fixture.memberId,
        provider_id: providerId,
        device_id: "Direct fixture",
        recorded_at: time(fixture, index * fixture.secondsBetweenPositions),
        recorded_date: fixture.day,
        source_metric_stream_id: randomUUID(),
        lat: 32,
        lng: -110 + index * 20 * degreesPerMeter,
        source_refreshed_at: sourceWatermark,
        refreshed_at: sourceWatermark,
        refresh_version: "1791712800123456789",
        is_deleted: 0,
      })),
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  }

  function writeFixtureScalar(
    fixture: Recording,
    second: number,
    id = randomUUID(),
    version = 1,
    channel = "heart_rate",
  ) {
    return clickhouse.insert({
      table: `${database}.sensor_scalar_sample`,
      format: "JSONEachRow",
      values: [
        {
          id,
          user_id: ownerId,
          activity_id: fixture.memberId,
          member_activity_id: fixture.memberId,
          device_id: "Direct fixture",
          provider_id: providerId,
          source_type: "api",
          recorded_date: fixture.day,
          recorded_at: time(fixture, second),
          channel,
          measurement_kind: "unknown",
          scalar: version === 1 ? 130 : 150,
          provider_priority: 20,
          _peerdb_version: version,
          _peerdb_is_deleted: 0,
        },
      ],
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  }

  const changedHeartRateId = randomUUID();

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    clickhouse = createClient({ url: requireClickHouseUrl() });
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    for (const query of [
      createActivitySourceRecordsSql(database),
      createActivityLocationSampleSql(database).replace(
        "activity_location_sample",
        "activity_ghost_location_sample",
      ),
      createActivityLocationMemberChangeSql(database),
      `CREATE TABLE ${database}.account_erasure_fence (user_hash String) ENGINE = ReplacingMergeTree ORDER BY user_hash`,
      ...buildIncrementalDedupedSensorBaseTableStatements(),
      createGhostTrackIndexSql,
      createGhostSessionPageSql,
      createGhostSessionHistorySql,
      ...(createScalarAuditMigration().statements ?? []),
    ]) {
      await nativeClient.command({ query });
    }
    await postgres.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${ownerId}, 'Ghost fixture owner'), (${otherOwnerId}, 'Other fixture owner')`);
    await postgres.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES (${providerId}, 'Ghost Serving Fixture', ${ownerId})`);
    for (const fixture of [anchor, newer, older]) await seedTrack(fixture);
    await insertPostgresMember(anchor, anchorSiblingMemberId);
    await insertPostgresMember(older, siblingMemberId);
    await clickhouse.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: siblingMemberId,
          group_id: older.activityId,
          user_id: ownerId,
          provider_id: providerId,
          canonical_type: "cycling",
          modality: "road",
          started_at: time(older, 0),
          ended_at: time(older, 60),
          source_synced_at: sourceWatermark,
          refresh_version: 1,
        },
      ],
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    await postgres.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
      VALUES (${aliasId}, ${ownerId}, NULL)`);
    await postgres.db.execute(sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
      VALUES (${aliasId}, ${anchor.activityId}, ${ownerId}, 'merge')`);
    for (const fixture of [anchor, older]) {
      for (let seconds = 0; seconds < fixture.secondsBetweenPositions * 20; seconds += 2) {
        await writeFixtureScalar(
          fixture,
          seconds,
          fixture === older && seconds === 0 ? changedHeartRateId : undefined,
        );
      }
    }
    for (let tick = 0; tick < 3; tick++) {
      await runGhostSessionHistory({ client: nativeClient, assertActive: async () => {} });
    }
  });

  afterAll(async () => {
    if (clickhouse) {
      try {
        await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${database}` });
      } finally {
        await clickhouse.close();
      }
    }
    await postgres?.cleanup();
  });

  it("keeps prepared names and climbs scoped to current consent, member, and altitude", async () => {
    vi.stubEnv("GHOST_MAP_LABELS_REGION", "eu");
    const settings = new SettingsRepository(postgres.db, ownerId);
    await settings.set("ghostMapLabels", true);
    const activity = { userId: ownerId, activityId: anchor.activityId };
    const consent = await readGhostMapLabelConsent(postgres.db, ownerId);
    const evidence = await getGhostTrackEvidence(nativeClient, activity);
    const track = await getGhostTrack(nativeClient, activity);
    if (!consent || evidence?.status !== "ready" || track.status !== "ready")
      throw new Error("Expected published recording with current consent");
    const [recorded] = recordedGhostRouteChunks(track.points).chunks;
    const origin = recorded?.[2];
    const finish = recorded?.[12];
    if (!origin || !finish) throw new Error("Expected original timed waypoints");
    const { originalIndex: startIndex, ...start } = origin;
    const { originalIndex: endIndex, ...end } = finish;
    const candidateKey = { ...activity, activityId: older.activityId };
    const candidateEvidence = await getGhostTrackEvidence(nativeClient, candidateKey);
    const candidateTrack = await getGhostTrack(nativeClient, candidateKey);
    if (candidateEvidence?.status !== "ready" || candidateTrack.status !== "ready")
      throw new Error("Expected a published earlier recording");
    const [candidateChunk] = recordedGhostRouteChunks(candidateTrack.points).chunks;
    const candidateOrigin = candidateChunk?.[2];
    const candidateFinish = candidateChunk?.[12];
    if (!candidateOrigin || !candidateFinish) throw new Error("Expected prior recorded bounds");
    const { originalIndex: _candidateStartIndex, ...candidateStart } = candidateOrigin;
    const { originalIndex: _candidateEndIndex, ...candidateEnd } = candidateFinish;
    const currentInterval = { start, end, elapsedMs: 20_000 };
    const candidateInterval = { start: candidateStart, end: candidateEnd, elapsedMs: 30_000 };
    const comparison = {
      anchor: currentInterval,
      candidate: candidateInterval,
      elapsedDifferenceMs: -10_000,
      timeBasis: "elapsed-including-recorded-stops",
      replay: [
        { anchor: start, candidate: candidateStart },
        { anchor: end, candidate: candidateEnd },
      ],
      replayDownsampled: false,
      metrics: { paceSecondsPerKm: null, heartRateBpm: null, powerWatts: null },
    };
    const label = {
      kind: "named-road",
      name: "Fixture Road",
      attribution: "© OpenStreetMap contributors · Powered by Geoapify",
    };
    const rawSectionId = ghostRecordedSectionId(
      anchor.activityId,
      "named-road",
      start.timestampMs,
      end.timestampMs,
    );
    const legacyNamedId = createHash("sha256")
      .update(
        JSON.stringify([
          anchor.activityId,
          "named-road",
          start.timestampMs,
          end.timestampMs,
          startIndex,
          endIndex,
        ]),
      )
      .digest("hex");
    const passId = "a".repeat(64);
    const sourceIdentity = {
      ...activity,
      sourceVersion: ghostRouteLabelsSourceVersion(evidence),
    };
    const cacheKey = ghostRouteLabelsCacheKey({
      ...sourceIdentity,
      consentRevision: consent.revision,
    });
    const climbKey = ghostRouteClimbsCacheKey(sourceIdentity);
    const pass = {
      passId,
      activityId: older.activityId,
      startedAt: candidateEvidence.startedAt,
      comparison,
      scalarProof: [],
    };
    const preparedSource = {
      status: "ready",
      anchorStamp: preparedGhostTrackStampSchema.parse(evidence),
      candidateStamps: [preparedGhostTrackStampSchema.parse(candidateEvidence)],
      bounded: false,
    };
    await queryCache.set(
      cacheKey,
      {
        status: "ready",
        sections: [
          {
            ...label,
            start: { ...start, originalIndex: startIndex },
            end: { ...end, originalIndex: endIndex },
          },
        ],
        coverage: { sampledWaypoints: 21, confirmedWaypoints: 21, bounded: true },
        prepared: preparedGhostSectionsSchema.parse({
          ...preparedSource,
          sections: [
            {
              ...label,
              sectionId: rawSectionId,
              anchor: currentInterval,
              historyCoverage: "partial",
              passes: [pass],
            },
          ],
        }),
      },
      60_000,
    );
    try {
      const owner = caller();
      const scope = { activityId: aliasId, sectionId: `named:${legacyNamedId}` };
      const detail = await owner.get({ activityId: aliasId });
      expect(detail.nameStatus).toBe("ready");
      expect(detail.mapCoverage).toBe("partial");
      expect(detail.sections.find(({ kind }) => kind === "named-road")).toEqual({
        ...label,
        sectionId: scope.sectionId,
        suggestedGhost: { passId, reason: "most-recent" },
        anchor: currentInterval,
      });
      await expect(owner.passes(scope)).resolves.toEqual({
        nextCursor: null,
        passes: [
          {
            passId,
            activityId: older.activityId,
            startedAt: candidateEvidence.startedAt,
            elapsedMs: 30_000,
          },
        ],
      });
      await expect(owner.compare({ ...scope, passId })).resolves.toEqual(comparison);
      const limited = caller(ownerId, hiddenHistory);
      await expect(limited.passes(scope)).resolves.toEqual({ nextCursor: null, passes: [] });
      await expect(limited.compare({ ...scope, passId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await postgres.db.execute(
        sql`UPDATE fitness.activity SET provider_absent_at = now() WHERE id = ${older.memberId}`,
      );
      try {
        await expect(owner.passes(scope)).resolves.toEqual({ nextCursor: null, passes: [] });
        await expect(owner.compare({ ...scope, passId })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      } finally {
        await postgres.db.execute(
          sql`UPDATE fitness.activity SET provider_absent_at = NULL WHERE id = ${older.memberId}`,
        );
      }
      await settings.set("ghostMapLabels", false);
      expect(await queryCache.get(cacheKey)).toBeDefined();
      await expect(owner.passes(scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(owner.compare({ ...scope, passId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const { mapCoverage: _mapCoverage, ...base } = detail;
      await expect(owner.get({ activityId: aliasId })).resolves.toEqual({
        ...base,
        nameStatus: "disabled",
        sections: detail.sections.filter(({ kind }) => kind !== "named-road"),
      });

      const altitudeId = randomUUID();
      await writeFixtureScalar(anchor, 6, altitudeId, 1, "altitude");
      const gateway = new ClickHouseActivitySensorStore(nativeClient);
      const altitudeProof = await readGhostAltitudeWindowProof(
        gateway.query.bind(gateway),
        ownerId,
        {
          activityId: evidence.activityId,
          memberActivityId: evidence.memberActivityId,
          providerId: evidence.providerId,
          deviceId: evidence.deviceId,
          startedAt: evidence.startedAt,
          endedAt: evidence.endedAt ?? time(anchor, 40),
        },
      );
      expect(altitudeProof?.count).toBe(1);
      const rawClimbId = ghostRecordedSectionId(
        anchor.activityId,
        "unnamed-climb",
        start.timestampMs,
        end.timestampMs,
      );
      await queryCache.set(
        climbKey,
        {
          status: "ready",
          altitudeProof,
          prepared: preparedGhostSectionsSchema.parse({
            ...preparedSource,
            sections: [
              {
                kind: "unnamed-climb",
                sectionId: rawClimbId,
                anchor: currentInterval,
                historyCoverage: "partial",
                passes: [pass],
              },
            ],
          }),
        },
        60_000,
      );
      const climbScope = { activityId: aliasId, sectionId: `climb:${rawClimbId}` };
      const optOut = await owner.get({ activityId: aliasId });
      expect(optOut.nameStatus).toBe("disabled");
      expect(optOut.sections.find(({ kind }) => kind === "unnamed-climb")).toMatchObject({
        sectionId: climbScope.sectionId,
        anchor: currentInterval,
      });
      await expect(owner.compare({ ...climbScope, passId })).resolves.toEqual(comparison);
      const enqueue = vi.mocked(enqueueGhostRouteClimbs).mockClear();
      await writeFixtureScalar(anchor, 6, altitudeId, 2, "altitude");
      await expect(owner.compare({ ...climbScope, passId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(enqueue).not.toHaveBeenCalled();
      const corrected = await owner.get({ activityId: aliasId });
      expect(corrected.sections.some(({ kind }) => kind === "unnamed-climb")).toBe(false);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(sourceIdentity);
    } finally {
      await queryCache.invalidate(cacheKey);
      await queryCache.invalidate(climbKey);
      await settings.set("ghostMapLabels", false);
      vi.unstubAllEnvs();
    }
  });

  it("drops a provider-absent selected candidate before the CDC mirror changes", async () => {
    const owner = caller();
    const base = await owner.get({ activityId: aliasId });
    const route = base.sections.find(({ kind }) => kind === "route");
    expect(route?.suggestedGhost?.reason).toBe("previous-best");
    const scope = { activityId: anchor.activityId, sectionId: route?.sectionId ?? "missing" };
    const prior = (await owner.passes(scope)).passes.find(
      ({ activityId }) => activityId === older.activityId,
    );
    const comparison = { ...scope, passId: prior?.passId ?? "missing" };
    await expect(owner.compare(comparison)).resolves.toMatchObject({
      elapsedDifferenceMs: -20_000,
    });

    await postgres.db.execute(sql`UPDATE fitness.activity SET provider_absent_at = now()
      WHERE id = ${older.memberId}`);
    try {
      const activity = new ActivityRepository(postgres.db, ownerId);
      await expect(activity.findSensorWindow(older.activityId)).resolves.toMatchObject({
        activityId: older.activityId,
        memberActivityIds: expect.arrayContaining([siblingMemberId]),
      });
      await expect(owner.compare(comparison)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(owner.passes(scope)).resolves.toEqual({
        passes: [expect.objectContaining({ activityId: newer.activityId })],
        nextCursor: null,
      });
      await expect(owner.get({ activityId: aliasId })).resolves.toMatchObject({
        availability: "ready",
        historyCoverage: "partial",
        sections: [{ suggestedGhost: { reason: "most-recent" } }],
      });
    } finally {
      await postgres.db.execute(sql`UPDATE fitness.activity SET provider_absent_at = NULL
        WHERE id = ${older.memberId}`);
    }
  });

  it.each([
    {
      change: "becomes provider absent",
      update: sql`provider_absent_at = now()`,
      restore: sql`provider_absent_at = NULL`,
    },
    {
      change: "moves to another group",
      update: sql`group_id = ${newer.activityId}`,
      restore: sql`group_id = ${anchor.activityId}`,
    },
  ])(
    "withholds anchor geometry when its selected member $change in Postgres",
    async ({ update, restore }) => {
      const owner = caller();
      const base = await owner.get({ activityId: aliasId });
      expect(base).toMatchObject({
        availability: "ready",
        sections: [{ geometry: expect.any(Array) }],
      });
      await postgres.db.execute(sql`UPDATE fitness.activity SET ${update}
      WHERE id = ${anchor.memberId}`);
      try {
        const activity = new ActivityRepository(postgres.db, ownerId);
        await expect(activity.findSensorWindow(aliasId)).resolves.toMatchObject({
          activityId: anchor.activityId,
          memberActivityIds: expect.arrayContaining([anchorSiblingMemberId]),
        });
        await expect(owner.get({ activityId: aliasId })).resolves.toMatchObject({
          availability: "processing",
          sections: [],
        });
      } finally {
        await postgres.db.execute(sql`UPDATE fitness.activity SET ${restore}
        WHERE id = ${anchor.memberId}`);
      }
    },
  );

  it("serves canonical passes, applies live access and invalidation, and retains replay when scalar proof changes", async () => {
    const owner = caller();
    const result = await owner.get({ activityId: aliasId });
    const route = result.sections.find(({ kind }) => kind === "route");
    expect(result).toMatchObject({ availability: "ready", historyCoverage: "complete" });
    expect(route?.suggestedGhost?.reason).toBe("previous-best");
    await expect(owner.get({ activityId: older.activityId })).resolves.toMatchObject({
      availability: "ready",
      historyCoverage: "complete",
      sections: [{ kind: "route", firstVisit: true, geometry: expect.any(Array) }],
    });
    const scope = { activityId: anchor.activityId, sectionId: route?.sectionId ?? "missing" };
    const passes = await owner.passes(scope);
    expect(passes.passes.map(({ activityId }) => activityId)).toEqual([
      newer.activityId,
      older.activityId,
    ]);
    expect(passes.passes[1]?.passId).toBe(route?.suggestedGhost?.passId);
    const comparison = { ...scope, passId: passes.passes[1]?.passId ?? "missing" };
    const timed = await owner.compare(comparison);
    expect(timed).toMatchObject({
      elapsedDifferenceMs: -20_000,
      metrics: { heartRateBpm: { anchor: 130, candidate: 130 } },
    });
    expect(timed.replay?.at(0)).toEqual({
      anchor: timed.anchor.start,
      candidate: timed.candidate.start,
    });

    const limited = caller(ownerId, hiddenHistory);
    await expect(limited.get({ activityId: aliasId })).resolves.toMatchObject({
      historyCoverage: "partial",
      sections: [{ suggestedGhost: { reason: "most-recent" } }],
    });
    await expect(limited.passes(scope)).resolves.toMatchObject({
      passes: [{ activityId: newer.activityId }],
    });
    await expect(limited.compare(comparison)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(otherOwnerId).get({ activityId: aliasId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(caller(otherOwnerId).compare(comparison)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await writeFixtureScalar(older, 0, changedHeartRateId, 2);
    await expect(owner.compare(comparison)).resolves.toEqual({
      ...timed,
      metrics: { ...timed.metrics, heartRateBpm: null, powerWatts: null },
    });

    await seedTrack(recording("2026-10-06", 3));
    await expect(owner.get({ activityId: aliasId })).resolves.toMatchObject({
      availability: "ready",
      historyCoverage: "partial",
      sections: [{ kind: "route", suggestedGhost: { reason: "most-recent" } }],
    });
    await expect(owner.compare(comparison)).resolves.toMatchObject({
      elapsedDifferenceMs: timed.elapsedDifferenceMs,
      replay: timed.replay,
    });

    await clickhouse.insert({
      table: `${database}.activity_location_member_change`,
      format: "JSONEachRow",
      values: [
        {
          user_id: ownerId,
          member_activity_id: siblingMemberId,
          changed_at: laterWatermark,
          has_live_sample: 1,
        },
      ],
    });
    await expect(owner.compare(comparison)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.get({ activityId: aliasId })).resolves.toMatchObject({
      historyCoverage: "partial",
    });
    await expect(owner.passes(scope)).resolves.toMatchObject({
      passes: [{ activityId: newer.activityId }],
    });

    await postgres.db.execute(sql`UPDATE fitness.activity SET deleted_at = now()
      WHERE id = ${newer.memberId}`);
    await expect(owner.passes(scope)).resolves.toEqual({ passes: [], nextCursor: null });

    await nativeClient.command({
      query: `INSERT INTO ingest.account_erasure_fence (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId: ownerId },
    });
    await expect(owner.get({ activityId: aliasId })).resolves.toMatchObject({
      availability: "unavailable",
      sections: [],
    });
    await expect(owner.compare(comparison)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
