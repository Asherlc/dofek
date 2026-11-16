import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CyclingThresholdRepository,
  cyclingThresholdEvidenceFromMetrics,
} from "./cycling-threshold-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000101";
const startedAt = "2026-06-15T00:30:00.000Z";

function settingsRow(ftp: number | null, effectiveFrom = "2026-06-15") {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    user_id: userId,
    sport: "cycling",
    threshold_hr: null,
    threshold_pace_per_km: null,
    ftp,
    power_zone_pcts: null,
    hr_zone_pcts: null,
    pace_zone_pcts: null,
    effective_from: effectiveFrom,
    notes: null,
    created_at: `${effectiveFrom}T00:00:00.000Z`,
    updated_at: `${effectiveFrom}T00:00:00.000Z`,
  };
}

function makeRepository(ftp: number | null, np: number | null, hasNpRow = true) {
  const execute = vi.fn().mockResolvedValue([
    {
      requested_id: activityId,
      activity_id: activityId,
      started_at: startedAt,
      ended_at: "2026-06-15T01:30:00.000Z",
      activity_date: "2026-06-15",
      canonical_type: "cycling",
      ftp,
      threshold_effective_from: "2026-06-15",
      threshold_source_record_id: "00000000-0000-4000-8000-000000000201",
    },
  ]);
  const query = vi
    .fn()
    .mockResolvedValue(
      hasNpRow ? [{ activity_id: activityId, normalized_power: np, power_sample_count: 3600 }] : [],
    );
  return {
    repository: new CyclingThresholdRepository(
      { execute },
      { query },
      userId,
      "America/Los_Angeles",
    ),
    execute,
    query,
  };
}

describe("CyclingThresholdRepository", () => {
  afterEach(() => vi.useRealTimers());

  it("returns configured current FTP and provenance from current sport settings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const execute = vi.fn().mockResolvedValue([settingsRow(258, "2026-01-02")]);
    const repository = new CyclingThresholdRepository(
      { execute },
      { query: vi.fn() },
      userId,
      "Pacific/Kiritimati",
    );

    await expect(repository.getCurrent()).resolves.toEqual({
      value: 258,
      unit: "watt",
      method: "configured",
      effective_from: "2026-01-02",
      source_record_id: "00000000-0000-4000-8000-000000000201",
      unavailable_reason: null,
    });
    const statement = execute.mock.calls[0]?.[0];
    expect(statement).toBeDefined();
    expect(new PgDialect().sqlToQuery(statement).params).toContain("2026-01-02");
  });

  it("preserves provenance for a current dated FTP clear", async () => {
    const repository = new CyclingThresholdRepository(
      { execute: vi.fn().mockResolvedValue([settingsRow(null)]) },
      { query: vi.fn() },
      userId,
      "UTC",
    );

    await expect(repository.getCurrent()).resolves.toEqual({
      value: null,
      unit: "watt",
      method: "configured",
      effective_from: "2026-06-15",
      source_record_id: "00000000-0000-4000-8000-000000000201",
      unavailable_reason: "No configured cycling FTP is effective today.",
    });
  });

  it("returns unavailable current evidence when there is no setting", async () => {
    const repository = new CyclingThresholdRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      { query: vi.fn() },
      userId,
      "UTC",
    );

    await expect(repository.getCurrent()).resolves.toEqual({
      value: null,
      unit: "watt",
      method: "configured",
      effective_from: null,
      source_record_id: null,
      unavailable_reason: "No configured cycling FTP is effective today.",
    });
  });

  it("maps nullable and complete per-activity evidence", () => {
    expect(cyclingThresholdEvidenceFromMetrics(null)).toEqual({
      value: null,
      unit: "watt",
      method: "configured",
      effective_from: null,
      source_record_id: null,
      unavailable_reason: "No configured cycling FTP is effective for this activity date.",
    });
    const metrics = {
      activity_id: activityId,
      started_at: startedAt,
      ended_at: "2026-06-15T01:30:00.000Z",
      activity_date: "2026-06-15",
      canonical_type: "cycling",
      normalized_power: 250,
      power_sample_count: 3600,
      ftp: 250,
      power_tss: 100,
      intensity_factor: 1,
      threshold: {
        value: 250,
        unit: "watt" as const,
        effective_from: "2026-06-15",
        source_record_id: "00000000-0000-4000-8000-000000000201",
        kind: "configured" as const,
      },
    };
    expect(cyclingThresholdEvidenceFromMetrics(metrics)).toEqual({
      value: 250,
      unit: "watt",
      method: "configured",
      effective_from: "2026-06-15",
      source_record_id: "00000000-0000-4000-8000-000000000201",
      unavailable_reason: null,
    });
  });

  it.each([
    { ftp: 250, intensityFactor: 1, powerTss: 100 },
    { ftp: 200, intensityFactor: 1.25, powerTss: 156.25 },
  ])(
    "computes manual FTP stress using elapsed duration: $ftp W",
    async ({ ftp, intensityFactor, powerTss }) => {
      const { repository, execute, query } = makeRepository(ftp, 250);

      const metrics = await repository.getForActivities([activityId]);

      expect(metrics.get(activityId)).toMatchObject({
        activity_date: "2026-06-15",
        normalized_power: 250,
        ftp,
        intensity_factor: intensityFactor,
        power_tss: powerTss,
        threshold: {
          value: ftp,
          effective_from: "2026-06-15",
          kind: "configured",
        },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[2]).toMatchObject({ activityIds: [activityId] });
    },
  );

  it("keeps the FTP for zones when the NP projection is unavailable", async () => {
    const { repository } = makeRepository(250, null, false);
    const metrics = (await repository.getForActivities([activityId])).get(activityId);
    expect(metrics).toMatchObject({
      ftp: 250,
      normalized_power: null,
      power_sample_count: null,
      intensity_factor: null,
      power_tss: null,
    });
  });

  it("keeps a recorded zero-power observation distinct from a missing NP row", async () => {
    const { repository } = makeRepository(250, 0, true);
    const metrics = (await repository.getForActivities([activityId])).get(activityId);
    expect(metrics).toMatchObject({
      ftp: 250,
      normalized_power: 0,
      power_sample_count: 3600,
      intensity_factor: 0,
      power_tss: 0,
    });
  });

  it("preserves a dated clear without falling back to an older FTP", async () => {
    const { repository } = makeRepository(null, 250);
    const metrics = (await repository.getForActivities([activityId])).get(activityId);
    expect(metrics).toMatchObject({
      ftp: null,
      intensity_factor: null,
      power_tss: null,
      threshold: {
        value: null,
        effective_from: "2026-06-15",
      },
    });
  });

  it("does not apply cycling FTP to other sport types", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        requested_id: activityId,
        activity_id: activityId,
        started_at: startedAt,
        ended_at: "2026-06-15T01:30:00.000Z",
        activity_date: "2026-06-15",
        canonical_type: "running",
        ftp: 250,
        threshold_effective_from: "2026-06-15",
        threshold_source_record_id: "00000000-0000-4000-8000-000000000201",
      },
    ]);
    const query = vi
      .fn()
      .mockResolvedValue([
        { activity_id: activityId, normalized_power: 250, power_sample_count: 3600 },
      ]);
    const repository = new CyclingThresholdRepository({ execute }, { query }, userId, "UTC");
    expect((await repository.getForActivities([activityId])).get(activityId)).toMatchObject({
      ftp: null,
      intensity_factor: null,
      power_tss: null,
      threshold: null,
    });
  });

  it("deduplicates requested IDs and skips ClickHouse for empty or invisible input", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn();
    const repository = new CyclingThresholdRepository({ execute }, { query }, userId, "UTC");

    expect(await repository.getForActivities([])).toEqual(new Map());
    expect(execute).not.toHaveBeenCalled();
    expect(await repository.getForActivities([activityId, activityId])).toEqual(new Map());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it("binds date-only and explicit timestamp access bounds through PostgreSQL", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        requested_id: activityId,
        activity_id: activityId,
        started_at: startedAt,
        ended_at: "2026-06-15T01:30:00.000Z",
        activity_date: "2026-06-15",
        canonical_type: "cycling",
        ftp: 250,
        threshold_effective_from: "2026-06-15",
        threshold_source_record_id: "00000000-0000-4000-8000-000000000201",
      },
    ]);
    const repository = new CyclingThresholdRepository(
      { execute },
      { query: vi.fn().mockResolvedValue([]) },
      userId,
      "America/Los_Angeles",
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-06-15",
        endDateExclusive: "2026-06-17T05:00:00.000Z",
      },
    );

    await repository.getForActivities([activityId]);
    const statement = execute.mock.calls[0]?.[0];
    expect(statement).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.params).toEqual(
      expect.arrayContaining(["2026-06-15", "2026-06-17T05:00:00.000Z", "America/Los_Angeles"]),
    );
    expect(compiled.sql).toContain("::date::timestamp without time zone AT TIME ZONE");
    expect(compiled.sql).toContain("::timestamptz");
  });

  it("does not add access bounds for full-access accounts", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        requested_id: activityId,
        activity_id: activityId,
        started_at: startedAt,
        ended_at: "2026-06-15T01:30:00.000Z",
        activity_date: "2026-06-15",
        canonical_type: "cycling",
        ftp: 250,
        threshold_effective_from: "2026-06-15",
        threshold_source_record_id: "00000000-0000-4000-8000-000000000201",
      },
    ]);
    const repository = new CyclingThresholdRepository(
      { execute },
      { query: vi.fn().mockResolvedValue([]) },
      userId,
      "America/Los_Angeles",
      { kind: "full", paid: true, reason: "paid_grant" },
    );

    await repository.getForActivities([activityId]);
    const statement = execute.mock.calls[0]?.[0];
    expect(statement).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.sql).not.toContain("activity.started_at >=");
    expect(compiled.params).not.toContain("2026-06-15");
    expect(compiled.params).not.toContain("2026-06-17T05:00:00.000Z");
  });
});
