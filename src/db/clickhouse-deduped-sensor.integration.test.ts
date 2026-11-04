import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoundedSensorFixture,
  type SensorFixtureRow,
  sensorId,
  sensorRow,
} from "./bounded-sensor-test-helpers.ts";

// These pages intentionally exclude unchanged competing sources and unrelated keys.
// Capture uses the real sealed-run reader and native compiler; executor checkpointing is separate.
describe("bounded canonical scalar and dedup pages", () => {
  let fixture: BoundedSensorFixture;
  beforeEach(async () => {
    fixture = new BoundedSensorFixture();
    await fixture.create();
  });
  afterEach(async () => {
    await fixture.close();
  });

  const expected = (winner: SensorFixtureRow, freshness = winner.ingested_at) => ({
    user_id: winner.user_id,
    recorded_at: winner.recorded_at,
    recorded_date: winner.recorded_at.slice(0, 10),
    channel: winner.channel === "rr_interval_ms" ? "heart_rate" : winner.channel,
    scalar: winner.channel === "rr_interval_ms" ? 60000 / (winner.scalar ?? 1) : winner.scalar,
    provider_id: winner.provider_id,
    member_activity_id: winner.activity_id,
    device_id: winner.device_id,
    source_external_id: winner.external_id,
    source_type: winner.source_type,
    measurement_kind: winner.channel === "rr_interval_ms" ? "estimated" : "direct",
    source_metric_stream_id: winner.id,
    source_activity_id: winner.activity_id,
    provider_priority: winner.provider_id === "fallback" ? 2 : 1,
    source_refreshed_at: freshness,
    is_deleted: 0,
    refreshed_at: freshness,
  });
  const unrelated = () => sensorRow(999, { recorded_at: "2026-01-01 00:59:00.123456" });
  const newer = (row: SensorFixtureRow, changes: Partial<SensorFixtureRow> = {}) => ({
    ...row,
    version: "9007199254740994",
    ingested_at: "2026-01-03 00:00:00.123456782",
    ...changes,
  });

  it("pagedDiscoveryRetainsOlderUnchangedCandidate", async () => {
    const reported = sensorRow(1);
    const interval = newer(sensorRow(2, { channel: "rr_interval_ms", scalar: 500 }));
    const competitors = Array.from({ length: 25 }, (_, i) =>
      sensorRow(100 + i, { provider_id: "fallback", scalar: 80 }),
    );
    await fixture.seed([reported, interval, ...competitors, unrelated()]);
    await fixture.page([{ before: null, after: interval }]);
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([expected(reported, interval.ingested_at)]);
  });

  it("deletedWinnerExposesProviderFallback", async () => {
    const winner = sensorRow(1),
      fallback = sensorRow(2, { provider_id: "fallback", scalar: 88 });
    const deleted = newer(winner, { is_deleted: 1 });
    await fixture.seed([winner, fallback, unrelated()]);
    await fixture.page([{ before: null, after: winner }]);
    await fixture.scalar();
    await fixture.seed([deleted]);
    await fixture.page([{ before: winner, after: deleted }], "2");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([expected(fallback, deleted.ingested_at)]);
  });

  it("allDeletedKeyEmitsTombstone", async () => {
    const winner = sensorRow(1),
      deleted = newer(winner, { is_deleted: 1 });
    await fixture.seed([winner, unrelated()]);
    await fixture.page([{ before: null, after: winner }]);
    await fixture.scalar();
    await fixture.seed([deleted]);
    await fixture.page([{ before: winner, after: deleted }], "2");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      {
        ...expected(deleted),
        scalar: null,
        provider_id: null,
        measurement_kind: "unknown",
        source_metric_stream_id: null,
        provider_priority: 65535,
        is_deleted: 1,
      },
    ]);
  });

  it("movedIdIsRetractedFromFormerKey", async () => {
    const original = sensorRow(1),
      moved = newer(original, { recorded_at: "2026-01-01 00:00:01.123456" });
    await fixture.seed([original, unrelated()]);
    await fixture.page([{ before: null, after: original }]);
    await fixture.scalar();
    await fixture.seed([moved]);
    await fixture.page([{ before: original, after: moved }], "2");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      {
        ...expected(original, moved.ingested_at),
        scalar: null,
        provider_id: null,
        measurement_kind: "unknown",
        source_metric_stream_id: null,
        provider_priority: 65535,
        is_deleted: 1,
      },
      expected(moved),
    ]);
  });

  it("invalidRrRetractsEstimatedHeartRate", async () => {
    const interval = sensorRow(1, { channel: "rr_interval_ms", scalar: 500 });
    const invalid = newer(interval, { scalar: null });
    await fixture.seed([interval, unrelated()]);
    await fixture.page([{ before: null, after: interval }]);
    await fixture.scalar();
    await fixture.seed([invalid]);
    await fixture.page([{ before: interval, after: invalid }], "2");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      {
        ...expected(invalid),
        scalar: null,
        provider_id: null,
        measurement_kind: "unknown",
        source_metric_stream_id: null,
        provider_priority: 65535,
        is_deleted: 1,
      },
    ]);
  });

  it("nullableProvenanceSurvivesPagedSelection", async () => {
    const winner = sensorRow(1),
      fallback = newer(
        sensorRow(2, {
          provider_id: "fallback",
          activity_id: sensorId(500),
          external_id: "other",
          device_id: "other",
          source_type: "other",
        }),
      );
    await fixture.seed([winner, fallback, unrelated()]);
    await fixture.page([{ before: null, after: fallback }]);
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([expected(winner, fallback.ingested_at)]);
  });

  it("unchangedWahooPowerWinsOverChangedStravaWithCompleteProvenance", async () => {
    await fixture.command(`INSERT INTO ${fixture.database}.sensor_provider_priority VALUES
      ('wahoo','power',1,0),('strava','power',2,0)`);
    const winner = sensorRow(1, {
      channel: "power",
      provider_id: "wahoo",
      scalar: 250,
      activity_id: sensorId(500),
      external_id: "wahoo-workout",
      device_id: "elemnt-bolt",
      source_type: "device",
    });
    const changed = newer(
      sensorRow(2, {
        channel: "power",
        provider_id: "strava",
        scalar: 275,
        activity_id: sensorId(501),
        external_id: "strava-activity",
        device_id: "strava-import",
        source_type: "api",
      }),
    );
    await fixture.seed([winner, changed, unrelated()]);
    await fixture.page([{ before: null, after: changed }]);
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([expected(winner, changed.ingested_at)]);
  });

  it("duplicateEffectsMatchFullStablePayload", async () => {
    const winner = sensorRow(1),
      fallback = newer(sensorRow(2, { provider_id: "fallback" }));
    await fixture.seed([winner, fallback, unrelated()]);
    await fixture.page([
      { before: null, after: fallback },
      { before: null, after: fallback },
    ]);
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([expected(winner, fallback.ingested_at)]);
  });
});

describe("bounded scalar prerequisite guards", () => {
  let fixture: BoundedSensorFixture;
  beforeEach(async () => {
    fixture = new BoundedSensorFixture();
    await fixture.create();
  });
  afterEach(async () => {
    await fixture.close();
  });

  it("emptyRawPopulationStillChecksPayload", async () => {
    const row = sensorRow(1);
    await fixture.seed([row]);
    await fixture.page([{ before: null, after: row }]);
    await fixture.command(
      `ALTER TABLE ${fixture.database}.metric_stream DELETE WHERE id=toUUID('${row.id}') SETTINGS mutations_sync=1`,
    );
    await expect(fixture.scalar()).rejects.toThrow("exact raw payload");
  });

  it("emptyStructuralPopulationStillChecksOwner", async () => {
    const row = sensorRow(1);
    await fixture.seed([row]);
    await fixture.page([{ before: null, after: row }]);
    await fixture.command(
      `ALTER TABLE ${fixture.database}.source_placement DELETE WHERE source_id=toUUID('${row.id}') SETTINGS mutations_sync=1`,
    );
    await expect(fixture.scalar()).rejects.toThrow("global owner");
  });

  it("rejectsConflictingGlobalOwnersBeforeChoosingLatestPlacement", async () => {
    const row = sensorRow(1);
    await fixture.seed([row, { ...row, user_id: sensorId(777), version: "9007199254740994" }]);
    await fixture.page([{ before: null, after: row }]);
    await expect(fixture.scalar()).rejects.toThrow("global owner");
  });

  it("rejectsAmbiguousExactStructuralRevision", async () => {
    const row = sensorRow(1);
    await fixture.seed([row, { ...row, recorded_at: "2026-01-01 00:00:01.123456" }]);
    await fixture.page([{ before: null, after: row }]);
    await expect(fixture.scalar()).rejects.toThrow("ambiguous global placement");
  });

  it("rejectsAmbiguousExactRawPayload", async () => {
    const row = sensorRow(1);
    await fixture.command(`SYSTEM STOP MERGES ${fixture.database}.metric_stream`);
    await fixture.seed([row]);
    await fixture.seed([{ ...row, scalar: 117 }]);
    await fixture.page([{ before: null, after: row }]);
    const retained = [];
    for (const form of ["", " FINAL"]) {
      const rows = await fixture.read(
        `SELECT id, version, ingested_at, scalar
        FROM ${fixture.database}.metric_stream${form}
        WHERE id=toUUID('${row.id}') LIMIT 4`,
      );
      retained.push({ form: form ? "FINAL" : "PLAIN", rows });
    }
    expect(retained[0]?.rows, "PLAIN fixture must retain both exact raw payloads").toHaveLength(2);
    expect(retained[0]?.rows).toEqual(
      expect.arrayContaining(
        [115, 117].map((scalar) => ({
          id: row.id,
          version: row.version,
          ingested_at: row.ingested_at,
          scalar,
        })),
      ),
    );
    await expect(fixture.scalar()).rejects.toThrow("ambiguous exact raw payload");
  });

  it("versionZeroUsesOriginalNanosecondIngestionTieBreaker", async () => {
    const old = sensorRow(1, { version: "0", device_id: "old" });
    const latest = {
      ...old,
      ingested_at: "2026-01-02 00:00:00.123456782",
      scalar: 123,
      device_id: null,
    };
    await fixture.seed([old, latest]);
    await fixture.page([{ before: old, after: latest }]);
    await fixture.scalar();
    expect(
      await fixture.read(
        `SELECT toString(_peerdb_version) AS version, toString(_peerdb_synced_at) AS ingested_at, scalar, device_id FROM ${fixture.database}.sensor_scalar_sample`,
      ),
    ).toEqual([{ version: "0", ingested_at: latest.ingested_at, scalar: 123, device_id: null }]);
    expect(await fixture.dedup()).toEqual([
      expect.objectContaining({
        scalar: 123,
        device_id: null,
        source_refreshed_at: latest.ingested_at,
      }),
    ]);
    await fixture.explain("scalar");
    await fixture.explain("dedup");
  });

  it("movedTwiceResolvesLatestStateBeforeFormerKeyMembership", async () => {
    const first = sensorRow(1);
    const middle = {
      ...first,
      recorded_at: "2026-01-01 00:00:01.123456",
      version: "9007199254740994",
      ingested_at: "2026-01-03 00:00:00.123456782",
    };
    const latest = {
      ...middle,
      recorded_at: "2026-01-01 00:00:02.123456",
      version: "9007199254740995",
      ingested_at: "2026-01-04 00:00:00.123456783",
    };
    await fixture.seed([first]);
    await fixture.page([{ before: null, after: first }]);
    await fixture.scalar();
    await fixture.seed([middle, latest]);
    await fixture.page([{ before: first, after: middle }], "2");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      expect.objectContaining({
        recorded_at: first.recorded_at,
        scalar: null,
        is_deleted: 1,
        source_refreshed_at: latest.ingested_at,
      }),
      expect.objectContaining({
        recorded_at: middle.recorded_at,
        scalar: null,
        is_deleted: 1,
        source_refreshed_at: latest.ingested_at,
      }),
    ]);
    await fixture.page([{ before: middle, after: latest }], "3");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      expect.objectContaining({ recorded_at: middle.recorded_at, scalar: null, is_deleted: 1 }),
      expect.objectContaining({ recorded_at: latest.recorded_at, scalar: 115, is_deleted: 0 }),
    ]);
  });

  it("unsupportedLatestChannelRetractsFormerEligibleSample", async () => {
    const first = sensorRow(1);
    const latest = {
      ...first,
      channel: "unsupported_sensor",
      scalar: null,
      version: "9007199254740994",
      ingested_at: "2026-01-03 00:00:00.123456782",
    };
    await fixture.seed([first]);
    await fixture.page([{ before: null, after: first }]);
    await fixture.scalar();
    await fixture.seed([latest]);
    await fixture.page([{ before: first, after: latest }], "2");
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      expect.objectContaining({
        channel: "heart_rate",
        scalar: null,
        is_deleted: 1,
        source_refreshed_at: latest.ingested_at,
      }),
    ]);
  });

  it("emptyReceiptCompilesAndExecutesWithNoKeys", async () => {
    await fixture.page([]);
    const scope = await fixture.capture("scalar");
    expect(scope).toMatchObject({
      next: { delivery: { offset: "9007199254740993" }, effectOrdinal: "-1" },
      exhausted: true,
      vars: { analytics_source_ids: [], analytics_keys: [] },
    });
    await fixture.scalar();
    expect(
      await fixture.read(`SELECT count() AS n FROM ${fixture.database}.sensor_scalar_sample`),
    ).toEqual([{ n: "0" }]);
  });

  it("typedPulsarCapturePreservesNativeCoordinatesThroughCompilation", async () => {
    const row = sensorRow(1);
    await fixture.seed([row]);
    await fixture.page([{ before: null, after: row }], "1", "pulsar");
    const scope = await fixture.capture("scalar");
    expect(scope.next).toEqual({
      delivery: { major: "10", minor: "9007199254740993", batch: -1 },
      effectOrdinal: "0",
    });
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      expect.objectContaining({
        scalar: 115,
        source_metric_stream_id: row.id,
        source_refreshed_at: row.ingested_at,
      }),
    ]);
  });

  it("rejects a raw revision arriving between scalar and dedup then converges after scalar refresh", async () => {
    const first = sensorRow(1),
      next = sensorRow(1, {
        version: "9007199254740994",
        scalar: 120,
        ingested_at: "2026-01-03 00:00:00.123456782",
      });
    await fixture.seed([first]);
    await fixture.page([{ before: null, after: first }]);
    await fixture.scalar();
    await fixture.seed([next]);
    await expect(fixture.dedup()).rejects.toThrow("current scalar publication");
    fixture.publicationRevision = "2";
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      expect.objectContaining({ scalar: 120, source_refreshed_at: next.ingested_at }),
    ]);
  });

  it("rejects missing raw payload of an unchanged candidate absent from page IDs", async () => {
    const changed = sensorRow(1),
      unchanged = sensorRow(2, { provider_id: "fallback" });
    await fixture.seed([changed, unchanged]);
    await fixture.page([{ before: null, after: changed }]);
    await fixture.command(
      `ALTER TABLE ${fixture.database}.metric_stream DELETE WHERE id=toUUID('${unchanged.id}') SETTINGS mutations_sync=1`,
    );
    await expect(fixture.scalar()).rejects.toThrow("exact raw payload");
  });

  it("rejects raw candidate missing structural history independently", async () => {
    const changed = sensorRow(1),
      unchanged = sensorRow(2, { provider_id: "fallback" });
    await fixture.seed([changed, unchanged]);
    await fixture.page([{ before: null, after: changed }]);
    await fixture.command(
      `ALTER TABLE ${fixture.database}.source_placement DELETE WHERE source_id=toUUID('${unchanged.id}') SETTINGS mutations_sync=1`,
    );
    await expect(fixture.scalar()).rejects.toThrow("global owner");
  });

  it("captures at most twenty receipt references before repeated keys collapse", async () => {
    const row = sensorRow(1);
    await fixture.seed([row]);
    await fixture.page(Array.from({ length: 21 }, () => ({ before: null, after: row })));
    const scope = await fixture.capture("scalar");
    expect(scope.next).toEqual({ delivery: { offset: "9007199254740993" }, effectOrdinal: "19" });
    expect(scope.exhausted).toBe(false);
    expect(scope.vars.analytics_source_ids).toEqual([row.id]);
    expect(scope.vars.analytics_keys).toHaveLength(1);
  });
});
