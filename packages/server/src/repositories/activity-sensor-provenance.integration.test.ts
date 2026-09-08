import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivityRow } from "../models/activity.ts";
import {
  createClickHouseTestActivitySensorStore,
  insertClickHouseMetricStreamRows,
  rebuildClickHouseSensorAnalytics,
  seedClickHouseMetricStreamRows,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ActivityTimeseriesRepository } from "./activity-timeseries-repository.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const activityId = randomUUID();
const wahooPowerId = randomUUID();
const pelotonPowerId = randomUUID();
const startedAt = new Date(Date.now() - 3_600_000).toISOString();
const endedAt = new Date(Date.parse(startedAt) + 600_000).toISOString();
const sampleAt = new Date(Date.parse(startedAt) + 1_000).toISOString();

const scalarProvenanceSchema = z.object({
  scalar: z.coerce.number(),
  provider_id: z.string(),
  member_activity_id: z.string(),
  device_id: z.string().nullable(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  source_metric_stream_id: z.string(),
  measurement_kind: z.enum(["direct", "estimated", "unknown"]),
});

const locationProvenanceSchema = z.object({
  provider_id: z.string(),
  member_activity_id: z.string(),
  device_id: z.string().nullable(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  source_metric_stream_id: z.string(),
  measurement_kind: z.enum(["direct", "estimated", "unknown"]),
});

const providerPrioritySchema = z.object({
  provider_id: z.string(),
  priority: z.coerce.number(),
});

const selectedSamplePrioritySchema = providerPrioritySchema.extend({
  scalar: z.coerce.number(),
});

describe("activity sensor provenance", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id) VALUES
        ('provenance_wahoo', 'Provenance Wahoo', ${userId}),
        ('provenance_peloton', 'Provenance Peloton', ${userId})
      ON CONFLICT DO NOTHING
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.sensor_provider_priority (provider_id, channel, priority) VALUES
        ('provenance_wahoo', 'power', 1),
        ('provenance_peloton', 'power', 2)
      ON CONFLICT (provider_id, channel) DO UPDATE SET priority = EXCLUDED.priority
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.activity (
        id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name
      ) VALUES (
        ${activityId}, 'provenance_wahoo', ${userId}, 'provenance-ride',
        'cycling', 'cycling', ${startedAt}, ${endedAt}, 'Provenance Ride'
      )
    `);
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    await seedClickHouseMetricStreamRows(testContext, [
      {
        id: wahooPowerId,
        activityId,
        userId,
        recordedAt: sampleAt,
        channel: "power",
        providerId: "provenance_wahoo",
        externalId: "wahoo-power-1",
        deviceId: "Wahoo trainer",
        sourceType: "fit",
        scalar: 0,
        metadata: JSON.stringify({ measurement_kind: "direct" }),
      },
      {
        id: pelotonPowerId,
        activityId,
        userId,
        recordedAt: sampleAt,
        channel: "power",
        providerId: "provenance_peloton",
        externalId: "peloton-power-1",
        deviceId: "Peloton Bike",
        sourceType: "api",
        scalar: 250,
        metadata: JSON.stringify({ measurement_kind: "estimated" }),
      },
      ...[1, 2].map((offsetSeconds) => ({
        activityId,
        userId,
        recordedAt: new Date(Date.parse(startedAt) + offsetSeconds * 1_000).toISOString(),
        channel: "location",
        providerId: "provenance_wahoo",
        externalId: `wahoo-location-${offsetSeconds}`,
        deviceId: "Wahoo computer",
        sourceType: "fit",
        point: `(-122.${offsetSeconds},37.${offsetSeconds})`,
        metadata: JSON.stringify({ measurement_kind: "direct" }),
      })),
      {
        activityId,
        userId,
        recordedAt: sampleAt,
        channel: "location",
        providerId: "provenance_peloton",
        externalId: "peloton-location-1",
        sourceType: "api",
        point: "(-73.1,40.1)",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("keeps a measured zero and the selected provider's source fields together", async () => {
    const priorities = await sensorStore.query(
      providerPrioritySchema,
      `SELECT provider_id, priority
      FROM postgres_fitness.sensor_provider_priority FINAL
      WHERE channel = 'power'
        AND provider_id IN ('provenance_wahoo', 'provenance_peloton')
        AND _peerdb_is_deleted = 0
      ORDER BY priority`,
    );
    expect(priorities).toEqual([
      { provider_id: "provenance_wahoo", priority: 1 },
      { provider_id: "provenance_peloton", priority: 2 },
    ]);
    const samplePriorities = await sensorStore.query(
      selectedSamplePrioritySchema,
      `SELECT provider_id, scalar, provider_priority AS priority
      FROM analytics.sensor_scalar_sample FINAL
      WHERE channel = 'power'
        AND recorded_at = parseDateTime64BestEffort({sampleAt:String}, 6, 'UTC')
      ORDER BY provider_id`,
      { sampleAt },
    );
    expect(samplePriorities).toEqual([
      { provider_id: "provenance_peloton", scalar: 250, priority: 2 },
      { provider_id: "provenance_wahoo", scalar: 0, priority: 1 },
    ]);

    const rows = await sensorStore.query(
      scalarProvenanceSchema,
      `SELECT
        scalar,
        provider_id,
        toString(member_activity_id) AS member_activity_id,
        device_id,
        source_external_id,
        source_type,
        toString(source_metric_stream_id) AS source_metric_stream_id,
        measurement_kind
      FROM analytics.activity_sensor_sample FINAL
      WHERE activity_id = {activityId:UUID}
        AND channel = 'power'
        AND is_deleted = 0`,
      { activityId },
    );

    expect(rows).toEqual([
      {
        scalar: 0,
        provider_id: "provenance_wahoo",
        member_activity_id: activityId,
        device_id: "Wahoo trainer",
        source_external_id: "wahoo-power-1",
        source_type: "fit",
        source_metric_stream_id: wahooPowerId,
        measurement_kind: "direct",
      },
    ]);
  });

  it("selects one GPS provider and retains its member and device evidence", async () => {
    const rows = await sensorStore.query(
      locationProvenanceSchema,
      `SELECT
        provider_id,
        toString(member_activity_id) AS member_activity_id,
        device_id,
        source_external_id,
        source_type,
        toString(source_metric_stream_id) AS source_metric_stream_id,
        measurement_kind
      FROM analytics.activity_location_sample FINAL
      WHERE activity_id = {activityId:UUID}
        AND is_deleted = 0
      ORDER BY recorded_at`,
      { activityId },
    );

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_id: "provenance_wahoo",
          member_activity_id: activityId,
          device_id: "Wahoo computer",
          source_type: "fit",
          measurement_kind: "direct",
        }),
      ]),
    );
  });

  it("serves synchronized scalar and GPS rows only from deduped activity models", async () => {
    const activity: ActivityRow = {
      id: activityId,
      canonical_type: "cycling",
      raw_type: "cycling",
      modality: "indoor_cycling",
      started_at: startedAt,
      ended_at: endedAt,
      name: "Provenance Ride",
      notes: null,
      perceived_exertion: null,
      provider_id: "provenance_wahoo",
      timezone: null,
      start_utc_offset_minutes: null,
      end_utc_offset_minutes: null,
      local_time_source: "unknown",
      subsource: null,
      source_providers: ["provenance_wahoo", "provenance_peloton"],
      source_external_ids: null,
      avg_hr: null,
      max_hr: null,
      avg_power: null,
      max_power: null,
      avg_speed: null,
      max_speed: null,
      avg_cadence: null,
      total_distance: null,
      elevation_gain_m: null,
      elevation_loss_m: null,
      sample_count: null,
      provider_absent_at: null,
    };
    const repository = new ActivityTimeseriesRepository(
      {
        findById: async () => activity,
        findSensorWindow: async () => ({
          activityId,
          userId,
          startedAt,
          endedAt,
          memberActivityIds: [activityId],
        }),
      },
      sensorStore,
    );

    const page = await repository.list({
      activityId,
      streams: ["power", "position"],
      resolution: "raw",
      fill: "none",
      cursor: null,
      limit: 500,
    });

    expect(page.timestamps).toEqual([
      new Date(Date.parse(startedAt) + 1_000).toISOString(),
      new Date(Date.parse(startedAt) + 2_000).toISOString(),
    ]);
    expect(page.streams.power?.values).toEqual([0, null]);
    expect(page.streams.position?.values).toEqual([
      [expect.closeTo(-122.1, 4), expect.closeTo(37.1, 4)],
      [expect.closeTo(-122.2, 4), expect.closeTo(37.2, 4)],
    ]);
    expect(page.sources.map((entry) => entry.provider_id)).toEqual([
      "provenance_wahoo",
      "provenance_wahoo",
      "provenance_wahoo",
    ]);
  });

  it("selects the next provider when the preferred sample is tombstoned", async () => {
    await insertClickHouseMetricStreamRows(testContext, [
      {
        id: wahooPowerId,
        activityId,
        userId,
        recordedAt: sampleAt,
        channel: "power",
        providerId: "provenance_wahoo",
        externalId: "wahoo-power-1",
        deviceId: "Wahoo trainer",
        sourceType: "fit",
        scalar: 0,
        metadata: JSON.stringify({ measurement_kind: "direct" }),
        isDeleted: true,
        version: 2,
      },
    ]);
    await rebuildClickHouseSensorAnalytics(testContext);

    const rows = await sensorStore.query(
      scalarProvenanceSchema,
      `SELECT
        scalar,
        provider_id,
        toString(member_activity_id) AS member_activity_id,
        device_id,
        source_external_id,
        source_type,
        toString(source_metric_stream_id) AS source_metric_stream_id,
        measurement_kind
      FROM analytics.activity_sensor_sample FINAL
      WHERE activity_id = {activityId:UUID}
        AND channel = 'power'
        AND is_deleted = 0`,
      { activityId },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        scalar: 250,
        provider_id: "provenance_peloton",
        source_metric_stream_id: pelotonPowerId,
        measurement_kind: "estimated",
      }),
    ]);
  });
});
