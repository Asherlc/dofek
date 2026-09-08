import { describe, expect, it, vi } from "vitest";
import { encodeAnalyticalCursor } from "../mcp/analytical-cursor.ts";
import type { ActivityRow } from "../models/activity.ts";
import type { ActivitySensorWindow } from "./activity-repository.ts";
import { ActivityTimeseriesRepository } from "./activity-timeseries-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const canonicalId = "00000000-0000-4000-8000-000000000002";
const aliasId = "00000000-0000-4000-8000-000000000003";
const otherActivityId = "00000000-0000-4000-8000-000000000004";
const startedAt = "2026-09-01T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();

const activity: ActivityRow = {
  id: canonicalId,
  canonical_type: "cycling",
  raw_type: "cycling",
  modality: "indoor_cycling",
  started_at: startedAt,
  ended_at: at(10),
  name: "Intervals",
  notes: null,
  perceived_exertion: null,
  provider_id: "wahoo",
  timezone: "America/Los_Angeles",
  start_utc_offset_minutes: -420,
  end_utc_offset_minutes: -420,
  local_time_source: "provider_timezone",
  subsource: "Wahoo trainer",
  source_providers: ["wahoo", "strava"],
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

const window: ActivitySensorWindow = {
  activityId: canonicalId,
  userId,
  startedAt,
  endedAt: at(10),
  memberActivityIds: [canonicalId, aliasId],
};

function makeRepository(rows: Array<Record<string, unknown>>) {
  const activities = {
    findById: vi.fn(async () => activity),
    findSensorWindow: vi.fn(async () => window),
  };
  const sensorStore = {
    query: vi.fn(async () => rows),
  };
  return {
    activities,
    sensorStore,
    repository: new ActivityTimeseriesRepository(activities, sensorStore),
  };
}

const source = {
  provider_id: "wahoo",
  member_activity_id: aliasId,
  device_id: "KICKR",
  source_external_id: "power-stream",
  source_type: "fit",
  source_metric_stream_id: "00000000-0000-4000-8000-000000000005",
  measurement_kind: "direct",
};

describe("ActivityTimeseriesRepository", () => {
  it("resolves an alias to its owned canonical activity before querying deduped samples", async () => {
    const { activities, repository, sensorStore } = makeRepository([
      { recorded_at: at(0), channel: "power", scalar: 0, lat: null, lng: null, ...source },
      { recorded_at: at(1), channel: "heart_rate", scalar: 140, lat: null, lng: null, ...source },
    ]);

    const result = await repository.list({
      activityId: aliasId,
      streams: ["power", "heart_rate"],
      resolution: "raw",
      fill: "none",
      cursor: null,
      limit: 1_000,
    });

    expect(activities.findById).toHaveBeenCalledWith(aliasId);
    expect(activities.findSensorWindow).toHaveBeenCalledWith(aliasId);
    expect(activities.findSensorWindow.mock.invocationCallOrder[0]).toBeLessThan(
      sensorStore.query.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_sensor_sample FINAL"),
      expect.objectContaining({
        activityId: canonicalId,
        channels: ["heart_rate", "power"],
        limit: 1_001,
        userId,
      }),
    );
    expect(sensorStore.query.mock.calls[0]?.[1]).not.toContain("ingest.metric_stream");
    expect(result).toMatchSnapshot();
    expect(result.activity).toEqual({
      id: canonicalId,
      startedAt,
      endedAt: at(10),
      sourceProviders: ["wahoo", "strava"],
      memberActivityIds: [canonicalId, aliasId],
      localTimeContext: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "provider_timezone",
      },
    });
    expect(result.streams.power?.values).toEqual([0, null]);
  });

  it("maps GPS and scalar stream names to only their deduped read models", async () => {
    const { repository, sensorStore } = makeRepository([
      {
        recorded_at: at(1),
        channel: "position",
        scalar: null,
        lat: 37.1,
        lng: -122.1,
        ...source,
      },
    ]);

    const result = await repository.list({
      activityId: canonicalId,
      streams: ["position", "distance", "temperature"],
      resolution: "raw",
      fill: "none",
      cursor: null,
      limit: 500,
    });

    const [query, params] = [
      sensorStore.query.mock.calls[0]?.[1],
      sensorStore.query.mock.calls[0]?.[2],
    ];
    expect(query).toContain("FROM analytics.activity_location_sample FINAL");
    expect(query).not.toContain("ingest.metric_stream");
    expect(params).toEqual(expect.objectContaining({ channels: ["distance", "temperature"] }));
    expect(result).toMatchSnapshot();
    expect(result.streams.position?.values).toEqual([[-122.1, 37.1]]);
  });

  it("paginates synchronized timestamps and deduplicates compact source references", async () => {
    const { repository } = makeRepository([
      { recorded_at: at(0), channel: "power", scalar: 100, lat: null, lng: null, ...source },
      { recorded_at: at(1), channel: "power", scalar: 110, lat: null, lng: null, ...source },
      { recorded_at: at(2), channel: "power", scalar: 120, lat: null, lng: null, ...source },
    ]);

    const result = await repository.list({
      activityId: canonicalId,
      streams: ["power"],
      resolution: "raw",
      fill: "none",
      cursor: null,
      limit: 2,
    });

    expect(result).toMatchSnapshot();
    expect(result.timestamps).toEqual([at(0), at(1)]);
    expect(result.streams.power?.sourceIndexes).toEqual([[0], [0]]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      provider_id: "wahoo",
      device_id: "KICKR",
      source_record_id: "power-stream",
      activity_id: canonicalId,
      member_activity_id: aliasId,
      measurement_kind: "direct",
    });
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("pages fixed-resolution missing buckets by time instead of native row count", async () => {
    const { repository, sensorStore } = makeRepository([]);

    const first = await repository.list({
      activityId: canonicalId,
      streams: ["power"],
      resolution: "5s",
      fill: "none",
      cursor: null,
      limit: 1,
    });
    expect(first.timestamps).toEqual([at(0)]);
    expect(first.streams.power?.states).toEqual(["missing"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(sensorStore.query.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ pageStartedAt: at(0), pageEndedAt: at(5) }),
    );

    const second = await repository.list({
      activityId: canonicalId,
      streams: ["power"],
      resolution: "5s",
      fill: "none",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.timestamps).toEqual([at(5)]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects a cursor bound to another activity before querying ClickHouse", async () => {
    const { repository, sensorStore } = makeRepository([]);
    const cursor = encodeAnalyticalCursor({
      version: 1,
      userId,
      activityId: otherActivityId,
      shape: JSON.stringify({ fill: "none", resolution: "raw", streams: ["power"] }),
      nextRecordedAt: at(1),
    });

    await expect(
      repository.list({
        activityId: canonicalId,
        streams: ["power"],
        resolution: "raw",
        fill: "none",
        cursor,
        limit: 500,
      }),
    ).rejects.toThrow("Cursor does not match this request");
    expect(sensorStore.query).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor before querying ClickHouse", async () => {
    const { repository, sensorStore } = makeRepository([]);

    await expect(
      repository.list({
        activityId: canonicalId,
        streams: ["power"],
        resolution: "raw",
        fill: "none",
        cursor: "not-a-valid-cursor",
        limit: 500,
      }),
    ).rejects.toThrow("Invalid analytical cursor");
    expect(sensorStore.query).not.toHaveBeenCalled();
  });

  it("rejects inaccessible activity ids without querying ClickHouse", async () => {
    const { activities, repository, sensorStore } = makeRepository([]);
    activities.findById.mockResolvedValueOnce(null);

    await expect(
      repository.list({
        activityId: otherActivityId,
        streams: ["power"],
        resolution: "raw",
        fill: "none",
        cursor: null,
        limit: 500,
      }),
    ).rejects.toThrow("Activity not found or not accessible.");
    expect(activities.findSensorWindow).not.toHaveBeenCalled();
    expect(sensorStore.query).not.toHaveBeenCalled();
  });
});
