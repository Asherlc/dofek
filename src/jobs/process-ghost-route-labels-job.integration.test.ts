// cspell:words osmtags
import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import { projectGhostTrackIndex } from "../analytics/ghost-track-index.ts";
import {
  createActivityLocationMemberChangeSql,
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "../db/activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "../db/activity-payload-dbt-source-test-helpers.ts";
import {
  GHOST_MAP_LABELS_SETTING_KEY,
  ghostRouteLabelsCachePrefix,
} from "../db/ghost-map-label-consent.ts";
import { getGhostTrackEvidence } from "../db/ghost-track-evidence.ts";
import { createGhostTrackIndexSql } from "../db/ghost-track-index-schema.ts";
import { createTestBarrier, setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { MemoryCacheStore } from "../lib/cache.ts";
import { ghostRouteLabelsCacheKey } from "../lib/ghost-route-labels-cache.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import {
  type AccountErasureWorkLockPool,
  createAccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";
import {
  processGhostRouteLabelsJob,
  readGhostRouteLabelsInput,
} from "./process-ghost-route-labels-job.ts";
import type { GhostRouteLabelsJobData } from "./queues.ts";

const providerId = "ghost_label_fixture";
const start = "2026-11-24 12:00:00.123456";
const end = "2026-11-24 12:00:40.123456";
const watermark = "2026-11-24 12:05:00.123456789";
const originalRevision = "2026-11-24T12:00:00.000001Z";
const withdrawnRevision = "2026-11-24T12:00:00.000002Z";
const newRevision = "2026-11-24T12:00:00.000003Z";
const config = {
  provider: { apiKey: "fixture-key", region: "global" },
  resultTtlMs: 120_000,
} as const;
const endpoint = "https://api.geoapify.com/v1/mapmatching";
const network = createIntegrationMswFixture();
const bodySchema = z.strictObject({
  mode: z.literal("bicycle"),
  waypoints: z.array(z.strictObject({ location: z.tuple([z.number(), z.number()]) })),
  lookup_step_osmtags: z.literal(true),
});

interface RecordingKey {
  userId: string;
  activityId: string;
}

describe("Ghost route label job lifecycle", () => {
  const database = `ghost_label_${randomUUID().replaceAll("-", "")}`;
  const scope = (query: string) => query.replaceAll(/(?:analytics|ingest)\./g, `${database}.`);
  let postgres: TestContext;
  let clickhouse: ReturnType<typeof createClient>;
  let workLock: AccountErasureWorkLockPool;
  const rawLoads: string[] = [];
  const client: AnalyticsQueryOwner["client"] = {
    query: (options) => {
      if (options.query_params?.pointFetchLimit)
        rawLoads.push(String(options.query_params.activityId));
      return clickhouse.query({ ...options, query: scope(options.query) });
    },
    command: (options) => clickhouse.command({ ...options, query: scope(options.query) }),
    insert: (options) => clickhouse.insert({ ...options, table: scope(options.table) }),
  };

  async function consent(key: RecordingKey, enabled: boolean, revision: string) {
    await postgres.db.execute(sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
      VALUES (${key.userId}, ${GHOST_MAP_LABELS_SETTING_KEY}, ${JSON.stringify(enabled)}::jsonb,
        ${revision}::timestamptz)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  }

  async function marker(key: RecordingKey, memberId: string, changedAt: string) {
    await client.insert({
      table: "analytics.activity_location_member_change",
      format: "JSONEachRow",
      values: [
        {
          user_id: key.userId,
          member_activity_id: memberId,
          changed_at: changedAt,
          has_live_sample: 1,
        },
      ],
    });
  }

  async function seed(recordingProvider = providerId) {
    const key = { userId: randomUUID(), activityId: randomUUID(), memberId: randomUUID() };
    await postgres.db.execute(sql`INSERT INTO fitness.user_profile(id,name)
      VALUES (${key.userId}, 'Synthetic Ghost label fixture')`);
    for (const member of [key.memberId, randomUUID()]) {
      await postgres.db.execute(sql`INSERT INTO fitness.activity
        (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type, modality,
          started_at, ended_at, name)
        VALUES (${member}, ${key.activityId}, ${key.userId}, ${recordingProvider}, ${member},
          'cycling', 'ride', 'road', ${start}, ${end}, 'Synthetic route')`);
    }
    await consent(key, true, originalRevision);
    await client.insert({
      table: "analytics.activity_source_records",
      format: "JSONEachRow",
      values: [
        {
          activity_id: key.memberId,
          group_id: key.activityId,
          user_id: key.userId,
          provider_id: recordingProvider,
          canonical_type: "cycling",
          modality: "road",
          started_at: start,
          ended_at: end,
          source_synced_at: watermark,
          refresh_version: 1,
        },
      ],
    });
    await client.insert({
      table: "analytics.activity_ghost_location_sample",
      format: "JSONEachRow",
      values: Array.from({ length: 9 }, (_, index) => ({
        user_id: key.userId,
        activity_id: key.activityId,
        member_activity_id: key.memberId,
        recorded_at: `2026-11-24 12:00:${String(index * 5).padStart(2, "0")}.123456`,
        recorded_date: "2026-11-24",
        provider_id: recordingProvider,
        device_id: "Direct fixture",
        source_metric_stream_id: randomUUID(),
        lat: 0,
        lng: index * 0.0003,
        source_refreshed_at: watermark,
        refreshed_at: watermark,
        refresh_version: "1795521900123456789",
        is_deleted: 0,
      })),
    });
    await marker(key, key.memberId, watermark);
    expect(await projectGhostTrackIndex({ client, assertActive: async () => {} })).toEqual({
      pendingTracks: 0,
    });
    rawLoads.length = 0;
    return key;
  }

  async function job(key: RecordingKey): Promise<GhostRouteLabelsJobData> {
    const input = await readGhostRouteLabelsInput(postgres.db, client, key);
    if (!input) throw new Error("Expected current job inputs");
    return {
      type: "ghost-route-labels",
      userId: key.userId,
      activityId: key.activityId,
      sourceVersion: input.sourceVersion,
      consentRevision: input.consentRevision,
    };
  }

  function observe(beforeResponse?: () => Promise<void>) {
    const calls: z.infer<typeof bodySchema>[] = [];
    network.use(
      http.post(endpoint, async ({ request }) => {
        const body = bodySchema.parse(await request.json());
        calls.push(body);
        await beforeResponse?.();
        const coordinates = body.waypoints.map(({ location }) => location);
        return HttpResponse.json({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "MultiLineString", coordinates: [coordinates] },
              properties: {
                legs: [
                  {
                    steps: [
                      {
                        name: "Fixture Road",
                        from_index: 0,
                        to_index: coordinates.length - 1,
                        osmtags: { highway: "primary" },
                      },
                    ],
                  },
                ],
                waypoints: coordinates.map((location, index) => ({
                  original_index: index,
                  original_location: location,
                  location,
                  match_type: "matched",
                  match_distance: 0,
                  leg_index: 0,
                  step_index: 0,
                })),
              },
            },
          ],
        });
      }),
    );
    return calls;
  }

  const run = (data: GhostRouteLabelsJobData, cache: MemoryCacheStore, enabled = true) =>
    runQueuedUserWorkUnlessAccountErasing(
      workLock,
      postgres.db,
      data.userId,
      "Ghost route labels",
      () =>
        processGhostRouteLabelsJob(data, {
          db: postgres.db,
          clickhouse: client,
          cache,
          ...(enabled ? { config } : {}),
        }),
    );

  async function raceResponse(
    data: GhostRouteLabelsJobData,
    cache: MemoryCacheStore,
    change: () => Promise<void>,
  ) {
    const started = createTestBarrier();
    const release = createTestBarrier();
    const calls = observe(async () => {
      started.resolve();
      await release.promise;
    });
    const pending = run(data, cache);
    try {
      await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("Expected a Geoapify request before job completion");
        }),
      ]);
      await expect(
        workLock.tryRunWithExclusiveUserLock(data.userId, async () => "exclusive"),
      ).resolves.toBeUndefined();
      await change();
    } finally {
      release.resolve();
      await pending;
    }
    expect(calls).toHaveLength(1);
  }

  beforeAll(async () => {
    network.activate({ onUnhandledFrame: "bypass" });
    postgres = await setupTestDatabase();
    workLock = createAccountErasureWorkLockPool(postgres.connectionString);
    await postgres.db.execute(sql`INSERT INTO fitness.provider(id,name)
      VALUES (${providerId}, 'Ghost label fixture'), ('apple_health', 'Apple Health')
      ON CONFLICT (id) DO NOTHING`);
    clickhouse = createClient({ url: requireClickHouseUrl() });
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    for (const query of [
      createActivitySourceRecordsSql(database),
      createActivityLocationSampleSql(database).replace(
        "activity_location_sample",
        "activity_ghost_location_sample",
      ),
      createActivityLocationMemberChangeSql(database),
      createGhostTrackIndexSql,
      `CREATE TABLE ${database}.account_erasure_fence (user_hash String)
        ENGINE = ReplacingMergeTree ORDER BY user_hash`,
    ])
      await client.command({ query });
  });

  afterEach(() => network.resetHandlers());
  afterAll(async () => {
    network.deactivate();
    await workLock?.close();
    await clickhouse?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await clickhouse?.close();
    await postgres?.cleanup();
  });

  it("short-circuits disabled, withdrawn and obsolete jobs before loading any points", async () => {
    const key = await seed();
    const data = await job(key);
    const cache = new MemoryCacheStore();
    const calls = observe();
    await run(data, cache, false);
    await run({ ...data, sourceVersion: "f".repeat(64) }, cache);
    await consent(key, false, withdrawnRevision);
    await run(data, cache);
    await consent(key, true, newRevision);
    const reenabled = await job(key);
    await marker(key, key.memberId, "2026-11-24 12:10:00.123456789");
    await run(reenabled, cache);
    expect(calls).toEqual([]);
    expect(rawLoads).toEqual([]);
    expect(await cache.get(ghostRouteLabelsCacheKey(data))).toBeUndefined();
  });

  it("caches current bounded labels and deduplicates exact completed jobs", async () => {
    const key = await seed();
    const data = await job(key);
    const cache = new MemoryCacheStore();
    const calls = observe();
    await run(data, cache);
    await run(data, cache);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.waypoints).toEqual(
      Array.from({ length: 9 }, (_, index) => ({ location: [index * 0.0003, 0] })),
    );
    expect(rawLoads).toEqual([key.activityId]);
    expect(await cache.get(ghostRouteLabelsCacheKey(data))).toMatchObject({
      status: "ready",
      sections: [
        {
          name: "Fixture Road",
          kind: "named-road",
          start: { originalIndex: 0 },
          end: { originalIndex: 8 },
        },
      ],
    });
  });

  it("blocks a newly reclassified Apple Health copy before crossing the provider boundary", async () => {
    const key = await seed("apple_health");
    const data = await job(key);
    const cache = new MemoryCacheStore();
    const calls = observe();

    for (const provenance of [
      { sourceName: null, raw: { sourceBundle: " COM.STRAVA.STRAVA " } },
      { sourceName: null, raw: { sourceName: " Strava " } },
      { sourceName: " STRAVA ", raw: {} },
    ]) {
      await postgres.db.execute(sql`UPDATE fitness.activity
        SET source_name = ${provenance.sourceName}, raw = ${JSON.stringify(provenance.raw)}::jsonb
        WHERE id = ${key.memberId}::uuid`);
      expect((await getGhostTrackEvidence(client, key))?.status).toBe("ready");
      await run(data, cache);
    }

    expect(calls).toEqual([]);
    expect(rawLoads).toEqual([]);
    expect(await cache.get(ghostRouteLabelsCacheKey(data))).toBeUndefined();
  });

  it("discards a blocked response after the selected primary member is removed", async () => {
    const key = await seed();
    const data = await job(key);
    const cache = new MemoryCacheStore();
    await raceResponse(data, cache, async () => {
      await postgres.db.execute(sql`UPDATE fitness.activity SET provider_absent_at = now()
        WHERE id = ${key.memberId}::uuid`);
    });
    expect((await getGhostTrackEvidence(client, key))?.status).toBe("ready");
    expect(await cache.get(ghostRouteLabelsCacheKey(data))).toBeUndefined();
  });

  it("discards an in-flight withdrawn revision and permits a distinct off/on cache key", async () => {
    const key = await seed();
    const data = await job(key);
    const cache = new MemoryCacheStore();
    await raceResponse(data, cache, () => consent(key, false, withdrawnRevision));
    await consent(key, true, newRevision);
    const next = await job(key);
    expect(ghostRouteLabelsCacheKey(next)).not.toBe(ghostRouteLabelsCacheKey(data));
    network.resetHandlers();
    const calls = observe();
    await run(data, cache);
    await run(next, cache);
    expect(calls).toHaveLength(1);
    expect(await cache.get(ghostRouteLabelsCacheKey(data))).toBeUndefined();
    expect(await cache.get(ghostRouteLabelsCacheKey(next))).toMatchObject({ status: "ready" });
  });

  it("evicts the exact attempted key when consent changes during cache publication", async () => {
    const key = await seed();
    const data = await job(key);
    const unrelated = `${ghostRouteLabelsCachePrefix(key.userId)}unrelated`;
    class WithdrawalCache extends MemoryCacheStore {
      override async set<T>(cacheKey: string, value: T, ttlMs: number) {
        await super.set(cacheKey, value, ttlMs);
        if (cacheKey === ghostRouteLabelsCacheKey(data))
          await consent(key, false, withdrawnRevision);
      }
    }
    const cache = new WithdrawalCache();
    await cache.set(unrelated, "keep", 120_000);
    const calls = observe();
    await run(data, cache);
    expect(calls).toHaveLength(1);
    expect(await cache.get(ghostRouteLabelsCacheKey(data))).toBeUndefined();
    expect(await cache.get(unrelated)).toBe("keep");
  });
});
