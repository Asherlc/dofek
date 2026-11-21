import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const schema = "cycling_durability_effort_fixture";
const userId = "00000000-0000-0000-0000-0000000000aa";
const rideMain = "00000000-0000-0000-0000-0000000000b1";
const rideExact = "00000000-0000-0000-0000-0000000000b2";
const memberMain = "00000000-0000-0000-0000-0000000000c1";
const memberExact = "00000000-0000-0000-0000-0000000000c2";
const rideStart = "2026-01-01 12:00:00";
const defaultWatermark = "2026-01-01 13:00:00.000000000";

interface ActivityRow {
  activityId: string;
  endedAtSeconds: number | null;
  powerSampleCount?: number;
  isDeleted?: number;
  refreshVersion?: number;
  refreshedAt?: string;
  canonicalType?: string;
  modality?: string | null;
  sourceMemberId?: string;
  sourceExternalId?: string;
  sourceRefreshedAt?: string;
  sourceEndedAtSeconds?: number | null;
  sourceRaw?: string | null;
  startedAt?: string;
}

interface SampleRow {
  activityId: string;
  offsetSeconds: number;
  power: number;
  memberActivityId?: string | null;
  providerId?: string;
  deviceId?: string | null;
  sourceExternalId?: string;
  measurementKind?: string;
  refreshVersion?: number;
  refreshedAt?: string;
  isDeleted?: number;
}

interface SourceRecordRow {
  activityId: string;
  groupId: string;
  providerId?: string;
  externalId?: string;
  raw?: string | null;
  startedAt?: string;
  endedAtSeconds?: number | null;
  priority?: number;
  refreshVersion?: number;
  refreshedAt?: string;
  isDeleted?: number;
}

const candidateSchema = z.object({
  start_offset_seconds: z.number(),
  end_offset_seconds: z.number(),
  avg_power: z.number(),
  prior_joules: z.number(),
  source_member_id: z.string(),
  provider_id: z.string(),
  source_external_id: z.string().nullable(),
  device_id: z.string().nullable(),
  measurement_kind: z.string(),
  power_provenance: z.string(),
  observed_samples: z.number().int(),
  median_sample_interval_seconds: z.number(),
  prefix_and_effort_largest_gap_seconds: z.number(),
  coverage_pct: z.number(),
});

const effortRowsSchema = z.array(
  z.object({
    activity_id: z.string(),
    duration_seconds: z.number().int(),
    candidates: z.array(candidateSchema),
    is_deleted: z.number().int(),
    refresh_version: z.string(),
    refreshed_at: z.string(),
  }),
);

describe("cycling_durability_effort read model", () => {
  let client: ClickHouseClient | undefined;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url)
      throw new Error("CLICKHOUSE_URL is required for cycling durability integration tests");
    client = createClient({
      url,
      request_timeout: 60_000,
      clickhouse_settings: { async_insert: 0 },
    });
    await createSchema(client);
  });

  beforeEach(async () => {
    await requireClient(client).command({ query: `TRUNCATE ALL TABLES FROM ${schema}` });
  });

  afterAll(async () => {
    if (client) await client.command({ query: `DROP DATABASE IF EXISTS ${schema} SYNC` });
    await client?.close();
  });

  it("keeps exact prefix work, an observed zero, and both sides of the Pareto frontier", async () => {
    const db = requireClient(client);
    await insertActivities(db, [
      { activityId: rideMain, endedAtSeconds: 3620, powerSampleCount: 3620 },
    ]);
    await insertSamples(db, [
      ...samples(rideMain, 0, 10, 400),
      ...samples(rideMain, 10, 20, 0),
      ...samples(rideMain, 20, 3600, 200),
      ...samples(rideMain, 3600, 3610, 250),
      ...samples(rideMain, 3610, 3620, 100),
    ]);
    await build(db, false);

    const candidates = await candidatesFor(db, rideMain, 10);
    expect(candidates.length).toBeGreaterThan(0);

    const early = candidates.find((candidate) => candidate.start_offset_seconds === 0);
    expect(early).toMatchObject({
      avg_power: 400,
      prior_joules: 0,
      source_member_id: memberMain,
      provider_id: "strava",
      source_external_id: defaultExternalId(rideMain),
      device_id: "Edge 530",
      measurement_kind: "direct",
      power_provenance: "direct",
      coverage_pct: 100,
      observed_samples: 10,
    });

    const afterWork = candidates.find((candidate) => candidate.start_offset_seconds === 3600);
    expect(afterWork).toMatchObject({
      avg_power: 250,
      prior_joules: 720000,
      source_member_id: memberMain,
      coverage_pct: 100,
      observed_samples: 10,
    });
    expect(afterWork?.prefix_and_effort_largest_gap_seconds).toBeLessThanOrEqual(5);

    expect(
      candidates
        .filter((candidate) => candidate.avg_power === 400)
        .every((candidate) => candidate.prior_joules < 720000),
    ).toBe(true);

    for (let index = 1; index < candidates.length; index += 1) {
      expect(candidates[index]?.prior_joules).toBeGreaterThanOrEqual(
        candidates[index - 1]?.prior_joules ?? 0,
      );
    }
  });

  it("admits an effort at exact equality with the requested work and drops the dominated prefix", async () => {
    const db = requireClient(client);
    await insertActivities(db, [
      { activityId: rideExact, endedAtSeconds: 3620, powerSampleCount: 3620 },
    ]);
    await insertSamples(db, [
      ...samples(rideExact, 0, 3600, 200),
      ...samples(rideExact, 3600, 3610, 250),
      ...samples(rideExact, 3610, 3620, 100),
    ]);
    await build(db, false);

    const candidates = await candidatesFor(db, rideExact, 10);
    const exact = candidates.find((candidate) => candidate.start_offset_seconds === 3600);
    expect(exact).toMatchObject({
      avg_power: 250,
      prior_joules: 720000,
      source_member_id: memberExact,
    });
    expect(
      candidates.some((candidate) => candidate.avg_power === 200 && candidate.prior_joules === 0),
    ).toBe(false);
  });

  it("rejects modality, gaps, provenance, source switches, and invalid-time barriers", async () => {
    const db = requireClient(client);
    const gapRide = rideId(1);
    const estimatedRide = rideId(2);
    const unknownRide = rideId(3);
    const otherFlagRide = rideId(4);
    const sourceChangeRide = rideId(5);
    const malformedRide = rideId(6);
    const indoorRide = rideId(7);
    const blankModalityRide = rideId(8);
    const deviceChangeRide = rideId(9);
    const gapMember = memberId(1);
    const otherMember = memberId(2);
    const changeMember = memberId(3);
    const lateMember = memberId(4);

    await insertActivities(db, [
      { activityId: gapRide, endedAtSeconds: 61, powerSampleCount: 36, sourceMemberId: gapMember },
      { activityId: estimatedRide, endedAtSeconds: 61, powerSampleCount: 61 },
      { activityId: unknownRide, endedAtSeconds: 61, powerSampleCount: 61 },
      {
        activityId: otherFlagRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: otherMember,
      },
      {
        activityId: sourceChangeRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: changeMember,
      },
      { activityId: malformedRide, endedAtSeconds: 17, powerSampleCount: 16 },
      { activityId: indoorRide, endedAtSeconds: 61, powerSampleCount: 61, modality: "indoor" },
      { activityId: blankModalityRide, endedAtSeconds: 61, powerSampleCount: 61, modality: "" },
      { activityId: deviceChangeRide, endedAtSeconds: 61, powerSampleCount: 61 },
    ]);
    await insertSamples(db, [
      ...samples(gapRide, 0, 5, 200),
      ...samples(gapRide, 35, 61, 250),
      ...samples(estimatedRide, 0, 61, 250, { measurementKind: "estimated" }),
      ...samples(unknownRide, 0, 61, 250, { measurementKind: "unknown" }),
      // The active member has no provenance; the Strava flag belongs to a different member.
      ...samples(otherFlagRide, 0, 61, 250, { measurementKind: "unknown" }),
      ...samples(sourceChangeRide, 0, 5, 200, { memberActivityId: changeMember }),
      ...samples(sourceChangeRide, 5, 61, 250, { memberActivityId: lateMember }),
      // Dropping invalid observations would let watts bridge these short gaps.
      ...samples(malformedRide, 0, 5, 200),
      { activityId: malformedRide, offsetSeconds: 5, power: Number.NaN },
      { activityId: malformedRide, offsetSeconds: 6, power: -5 },
      ...samples(malformedRide, 7, 17, 200),
      ...samples(indoorRide, 0, 61, 250),
      ...samples(blankModalityRide, 0, 61, 250),
      ...samples(deviceChangeRide, 0, 5, 200, { deviceId: "Edge 530" }),
      ...samples(deviceChangeRide, 5, 61, 250, { deviceId: "Wahoo" }),
    ]);
    await insertSourceRecords(db, [
      {
        activityId: memberId(5),
        groupId: otherFlagRide,
        raw: JSON.stringify({ device_watts: true }),
      },
    ]);
    await build(db, false);

    for (const activityId of [
      gapRide,
      estimatedRide,
      unknownRide,
      otherFlagRide,
      sourceChangeRide,
      malformedRide,
      deviceChangeRide,
    ]) {
      expect(await candidatesFor(db, activityId, 10)).toEqual([]);
    }
    for (const activityId of [indoorRide, blankModalityRide]) {
      expect(await effortRows(db, activityId)).toEqual([]);
    }
  });

  it("requires coverage at the source start and respects the recorded source end", async () => {
    const db = requireClient(client);
    const lateStart = rideId(60);
    const shortSource = rideId(61);
    const deletedObservation = rideId(62);
    const nonStravaFlag = rideId(63);

    await insertActivities(db, [
      { activityId: lateStart, endedAtSeconds: 30 },
      { activityId: shortSource, endedAtSeconds: 30, sourceEndedAtSeconds: 6 },
      { activityId: deletedObservation, endedAtSeconds: 30 },
      { activityId: nonStravaFlag, endedAtSeconds: 30 },
    ]);
    await insertSourceRecords(db, [
      {
        activityId: defaultMemberId(nonStravaFlag),
        groupId: nonStravaFlag,
        providerId: "fit",
        raw: JSON.stringify({ device_watts: true }),
        endedAtSeconds: 30,
        refreshVersion: 2,
      },
    ]);
    await insertSamples(db, [
      ...samples(lateStart, 1, 31, 250),
      ...samples(shortSource, 0, 31, 250),
      ...samples(deletedObservation, 0, 5, 200),
      ...samples(deletedObservation, 5, 6, 900, { isDeleted: 1 }),
      ...samples(deletedObservation, 6, 31, 200),
      ...samples(nonStravaFlag, 0, 31, 250, { providerId: "fit", measurementKind: "unknown" }),
    ]);
    await build(db, false);

    for (const activityId of [lateStart, shortSource, deletedObservation, nonStravaFlag]) {
      expect(await candidatesFor(db, activityId, 10), activityId).toEqual([]);
    }
  });

  it("reports the exact effort end between recorded samples", async () => {
    const db = requireClient(client);
    const activityId = rideId(64);
    await insertActivities(db, [{ activityId, endedAtSeconds: 15 }]);
    await insertSamples(db, coarseSamples(activityId, 0, 6, 3, 200));
    await build(db, false);

    const candidates = await candidatesFor(db, activityId, 10);
    expect(candidates).toEqual([
      expect.objectContaining({ start_offset_seconds: 3, end_offset_seconds: 13, avg_power: 200 }),
    ]);
  });

  it("uses the exact member's Boolean Strava flag and rejects estimated or non-Boolean evidence", async () => {
    const db = requireClient(client);
    const flagTrueRide = rideId(11);
    const flagFalseRide = rideId(12);
    const flagStringRide = rideId(13);
    const estimatedRide = rideId(14);
    const flagTrueMember = memberId(11);
    const flagFalseMember = memberId(12);
    const flagStringMember = memberId(13);
    const estimatedMember = memberId(14);

    await insertActivities(db, [
      {
        activityId: flagTrueRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: flagTrueMember,
        sourceRaw: JSON.stringify({ device_watts: true }),
      },
      {
        activityId: flagFalseRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: flagFalseMember,
        sourceRaw: JSON.stringify({ device_watts: false }),
      },
      {
        activityId: flagStringRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: flagStringMember,
        sourceRaw: JSON.stringify({ device_watts: "true" }),
      },
      {
        activityId: estimatedRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: estimatedMember,
        sourceRaw: JSON.stringify({ device_watts: true }),
      },
    ]);
    await insertSamples(db, [
      ...samples(flagTrueRide, 0, 61, 240, { measurementKind: "unknown" }),
      ...samples(flagFalseRide, 0, 61, 240, { measurementKind: "unknown" }),
      ...samples(flagStringRide, 0, 61, 240, { measurementKind: "unknown" }),
      ...samples(estimatedRide, 0, 61, 240, { measurementKind: "estimated" }),
    ]);
    await build(db, false);

    const flagged = await candidatesFor(db, flagTrueRide, 10);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]).toMatchObject({ power_provenance: "meter_flag", avg_power: 240 });
    for (const activityId of [flagFalseRide, flagStringRide, estimatedRide]) {
      expect(await candidatesFor(db, activityId, 10)).toEqual([]);
    }
  });

  it("caps the continuity gap at ten seconds and scales smaller caps with the median interval", async () => {
    const db = requireClient(client);
    const fineGapRide = rideId(21);
    const fineBreakRide = rideId(22);
    const coarseGapRide = rideId(23);
    await insertActivities(db, [
      { activityId: fineGapRide, endedAtSeconds: 61, powerSampleCount: 22 },
      { activityId: fineBreakRide, endedAtSeconds: 61, powerSampleCount: 22 },
      { activityId: coarseGapRide, endedAtSeconds: 61, powerSampleCount: 22 },
    ]);
    await insertSamples(db, [
      // 1-second sampling: cap = max(5, 2*1) = 5, so a 4-second gap is continuous.
      ...samples(fineGapRide, 0, 10, 200),
      ...samples(fineGapRide, 14, 25, 240),
      // A 6-second gap exceeds the 5-second floor and breaks continuity.
      ...samples(fineBreakRide, 0, 10, 200),
      ...samples(fineBreakRide, 16, 27, 240),
      // 4-second sampling: cap = min(10, 2*4) = 8, so a 7-second gap is continuous.
      ...coarseSamples(coarseGapRide, 0, 2, 4, 200),
      ...coarseSamples(coarseGapRide, 9, 3, 4, 240),
    ]);
    await build(db, false);

    expect((await candidatesFor(db, fineGapRide, 10)).length).toBeGreaterThan(0);
    expect(await candidatesFor(db, fineBreakRide, 10)).toEqual([]);
    expect((await candidatesFor(db, coarseGapRide, 10)).length).toBeGreaterThan(0);
  });

  it("handles incomplete rides, source-flag changes, soft deletion, and late samples", async () => {
    const db = requireClient(client);
    const incompleteRide = rideId(31);
    const updatedRide = rideId(32);
    const deletedRide = rideId(33);
    const updatedMember = memberId(31);
    const deletedMember = memberId(32);

    await insertActivities(db, [
      { activityId: incompleteRide, endedAtSeconds: null, powerSampleCount: 61 },
      {
        activityId: updatedRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: updatedMember,
        sourceRaw: JSON.stringify({ device_watts: true }),
      },
      {
        activityId: deletedRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: deletedMember,
        sourceRaw: JSON.stringify({ device_watts: true }),
      },
      { activityId: rideExact, endedAtSeconds: 3640, powerSampleCount: 3620 },
      { activityId: rideMain, endedAtSeconds: 3620, powerSampleCount: 3620 },
    ]);
    await insertSamples(db, [
      ...samples(incompleteRide, 0, 61, 200),
      ...samples(updatedRide, 0, 61, 200, {
        memberActivityId: updatedMember,
        measurementKind: "unknown",
      }),
      ...samples(deletedRide, 0, 61, 200, {
        memberActivityId: deletedMember,
        measurementKind: "unknown",
      }),
      ...samples(rideExact, 0, 3600, 200),
      ...samples(rideExact, 3600, 3610, 250),
      ...samples(rideExact, 3610, 3620, 100),
      ...samples(rideMain, 0, 3620, 200),
    ]);
    await build(db, false);

    expect(await effortRows(db, incompleteRide)).toEqual([]);
    expect((await candidatesFor(db, updatedRide, 10)).length).toBeGreaterThan(0);
    expect((await candidatesFor(db, deletedRide, 10)).length).toBeGreaterThan(0);
    const cleanBefore = await effortRows(db, rideMain);

    // Changing only the source flag must invalidate the prior projection.
    await insertSourceRecords(db, [
      {
        activityId: updatedMember,
        groupId: updatedRide,
        raw: JSON.stringify({ device_watts: false }),
        refreshVersion: 2,
        refreshedAt: "2026-01-02 00:00:00.000000000",
      },
    ]);
    await build(db, true);
    expect(await candidatesFor(db, updatedRide, 10)).toEqual([]);

    await insertActivities(db, [
      {
        activityId: deletedRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        isDeleted: 1,
        refreshVersion: 2,
        refreshedAt: "2026-01-02 00:00:00.000000000",
      },
    ]);
    await build(db, true);
    const tombstones = await effortRows(db, deletedRide);
    expect(tombstones.length).toBeGreaterThan(0);
    expect(tombstones.every((row) => row.is_deleted === 1)).toBe(true);

    // Late samples move only the sensor watermark.
    await insertSamples(db, [
      ...samples(rideExact, 3620, 3631, 320, {
        refreshVersion: 2,
        refreshedAt: "2026-01-03 00:00:00.000000000",
      }),
    ]);
    await insertSensorSummaries(db, [
      {
        activityId: rideExact,
        refreshVersion: 2,
        refreshedAt: "2026-01-03 00:00:00.000000000",
      },
    ]);
    await build(db, true);
    const late = await candidatesFor(db, rideExact, 10);
    expect(
      late.some((candidate) => candidate.avg_power === 320 && candidate.prior_joules >= 720000),
    ).toBe(true);
    expect(await effortRows(db, rideMain)).toEqual(cleanBefore);
  });

  it("resolves the measured stream through canonical membership, not raw group id or source priority", async () => {
    const db = requireClient(client);
    const mergedRide = rideId(51);
    const rawGroup = rideId(99);
    const streamMember = memberId(51);
    const summaryMember = memberId(52);

    await insertActivities(db, [
      {
        activityId: mergedRide,
        endedAtSeconds: 61,
        powerSampleCount: 61,
        sourceMemberId: streamMember,
        sourceExternalId: "stream-external",
      },
    ]);
    await insertDedupedMembers(db, [{ activityId: mergedRide, memberId: summaryMember }]);
    await insertSourceRecords(db, [
      // The stream member's raw group_id disagrees with canonical identity after a
      // merge. Its meter flag and unique per-sample external IDs still qualify.
      {
        activityId: streamMember,
        groupId: rawGroup,
        externalId: "stream-external",
        raw: JSON.stringify({ device_watts: true }),
        priority: 10,
        refreshVersion: 2,
        refreshedAt: "2026-01-02 00:00:00.000000000",
      },
      {
        activityId: summaryMember,
        groupId: mergedRide,
        providerId: "peloton",
        priority: 0,
      },
    ]);
    await insertSamples(
      db,
      samples(mergedRide, 0, 61, 240, {
        memberActivityId: streamMember,
        measurementKind: "unknown",
      }),
    );
    await build(db, false);

    const candidates = await candidatesFor(db, mergedRide, 10);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toMatchObject({
      source_member_id: streamMember,
      provider_id: "strava",
      source_external_id: "stream-external",
      power_provenance: "meter_flag",
      avg_power: 240,
    });
  });

  it("bounds every build and checkpoints a ride with no candidates so later rides are processed", async () => {
    const db = requireClient(client);
    const rejectedRide = rideId(41);
    const firstGoodRide = rideId(42);
    const secondGoodRide = rideId(43);

    await insertActivities(db, [
      { activityId: rejectedRide, endedAtSeconds: 3, powerSampleCount: 3 },
      { activityId: firstGoodRide, endedAtSeconds: 61, powerSampleCount: 61 },
      { activityId: secondGoodRide, endedAtSeconds: 61, powerSampleCount: 61 },
    ]);
    await insertSamples(db, [
      ...samples(rejectedRide, 0, 3, 200),
      ...samples(firstGoodRide, 0, 61, 200),
      ...samples(secondGoodRide, 0, 61, 200),
    ]);

    await build(db, false, 2);
    const rejectedBefore = await effortRows(db, rejectedRide);
    expect(rejectedBefore).toHaveLength(1);
    expect(rejectedBefore[0]).toMatchObject({ duration_seconds: 0, is_deleted: 0 });
    expect(rejectedBefore[0]?.candidates).toEqual([]);
    expect((await effortRows(db, firstGoodRide)).some((row) => row.duration_seconds === 10)).toBe(
      true,
    );
    expect(await effortRows(db, secondGoodRide)).toEqual([]);

    await build(db, true, 2);
    expect(await effortRows(db, rejectedRide)).toEqual(rejectedBefore);
    expect((await effortRows(db, secondGoodRide)).some((row) => row.duration_seconds === 10)).toBe(
      true,
    );
  });
});

function defaultMemberId(activityId: string): string {
  if (activityId === rideMain) return memberMain;
  if (activityId === rideExact) return memberExact;
  const index = Number.parseInt(activityId.slice(-12), 10);
  return memberId(Number.isFinite(index) ? index : 0);
}

function defaultExternalId(activityId: string): string {
  return `external-${activityId.slice(-4)}`;
}

function sampleExternalId(activityId: string, offsetSeconds: number): string {
  return `strava:${activityId}:0:power:${timestampAt(offsetSeconds)}`;
}

function sourceEndedAt(row: ActivityRow): string | null {
  const endedAt = row.sourceEndedAtSeconds ?? row.endedAtSeconds;
  return endedAt === null || endedAt === undefined ? null : timestampAt(endedAt);
}

function samples(
  activityId: string,
  startOffset: number,
  endOffset: number,
  power: number,
  overrides: Partial<SampleRow> = {},
): SampleRow[] {
  return Array.from({ length: endOffset - startOffset }, (_, index) => ({
    activityId,
    offsetSeconds: startOffset + index,
    power,
    memberActivityId: defaultMemberId(activityId),
    providerId: "strava",
    deviceId: "Edge 530",
    sourceExternalId:
      overrides.sourceExternalId ?? sampleExternalId(activityId, startOffset + index),
    measurementKind: "direct",
    ...overrides,
    refreshVersion: overrides.refreshVersion ?? 1,
    refreshedAt: overrides.refreshedAt ?? defaultWatermark,
    isDeleted: overrides.isDeleted ?? 0,
  }));
}

function coarseSamples(
  activityId: string,
  startOffset: number,
  count: number,
  stepSeconds: number,
  power: number,
): SampleRow[] {
  return Array.from({ length: count }, (_, index) => ({
    activityId,
    offsetSeconds: startOffset + index * stepSeconds,
    power,
    memberActivityId: defaultMemberId(activityId),
    providerId: "strava",
    deviceId: "Edge 530",
    sourceExternalId: sampleExternalId(activityId, startOffset + index * stepSeconds),
    measurementKind: "direct",
    refreshVersion: 1,
    refreshedAt: defaultWatermark,
    isDeleted: 0,
  }));
}

function rideId(index: number): string {
  return `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
}

function memberId(index: number): string {
  return `00000000-0000-0000-0000-${String(100 + index).padStart(12, "0")}`;
}

function renderModelSql(database: string, isIncremental: boolean, batchSize = 64): string {
  return renderDbtModelSql(readModelSql("cycling_durability_effort.sql"), { isIncremental })
    .replaceAll("{{ ref('activity_summary_rows') }}", `${database}.activity_summary_rows`)
    .replaceAll("{{ ref('activity_sensor_sample') }}", `${database}.activity_sensor_sample`)
    .replaceAll("{{ ref('activity_source_records') }}", `${database}.activity_source_records`)
    .replaceAll("{{ ref('deduped_activity_members') }}", `${database}.deduped_activity_members`)
    .replaceAll(
      "{{ ref('activity_sensor_summary_rows') }}",
      `${database}.activity_sensor_summary_rows`,
    )
    .replaceAll("{{ this }}", `${database}.cycling_durability_effort`)
    .replaceAll("{{ cycling_durability_dirty_key_batch_size }}", String(batchSize))
    .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1");
}

async function build(
  client: ClickHouseClient,
  isIncremental: boolean,
  batchSize = 64,
): Promise<void> {
  await runStatements(client, [
    `INSERT INTO ${schema}.cycling_durability_effort\n${renderModelSql(schema, isIncremental, batchSize)}`,
  ]);
}

async function createSchema(client: ClickHouseClient): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${schema} SYNC`,
    `CREATE DATABASE ${schema}`,
    `CREATE TABLE ${schema}.activity_summary_rows (
      activity_id UUID,
      user_id UUID,
      canonical_type String,
      modality Nullable(String),
      started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')),
      is_deleted UInt8,
      power_sample_count UInt64,
      refresh_version UInt64,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    `CREATE TABLE ${schema}.activity_sensor_sample (
      activity_id UUID,
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      recorded_date Date,
      channel LowCardinality(String),
      scalar Nullable(Float64),
      provider_id Nullable(String),
      member_activity_id Nullable(UUID),
      device_id Nullable(String),
      source_external_id Nullable(String),
      source_type Nullable(String),
      source_metric_stream_id Nullable(UUID),
      measurement_kind LowCardinality(String) DEFAULT 'unknown',
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`,
    `CREATE TABLE ${schema}.activity_source_records (
      activity_id UUID,
      group_id UUID,
      user_id UUID,
      provider_id Nullable(String),
      external_id Nullable(String),
      modality Nullable(String),
      started_at Nullable(DateTime64(6, 'UTC')),
      ended_at Nullable(DateTime64(6, 'UTC')),
      raw Nullable(String),
      priority Int32,
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (activity_id, user_id)`,
    `CREATE TABLE ${schema}.deduped_activity_members (
      activity_id UUID,
      user_id UUID,
      member_activity_id UUID,
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id)`,
    `CREATE TABLE ${schema}.activity_sensor_summary_rows (
      activity_id UUID,
      user_id UUID,
      is_deleted UInt8,
      source_refresh_version UInt64,
      refresh_version UInt64,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    `CREATE TABLE ${schema}.cycling_durability_effort (
      activity_id UUID,
      user_id UUID,
      started_at Nullable(DateTime64(6, 'UTC')),
      duration_seconds Int32,
      candidates Array(Tuple(
        start_offset_seconds Float64,
        end_offset_seconds Float64,
        avg_power Float64,
        prior_joules Float64,
        source_member_id String,
        provider_id String,
        source_external_id Nullable(String),
        device_id Nullable(String),
        measurement_kind String,
        power_provenance String,
        observed_samples UInt64,
        median_sample_interval_seconds Float64,
        prefix_and_effort_largest_gap_seconds Float64,
        coverage_pct Float64
      )),
      is_deleted UInt8,
      refresh_version UInt64,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id, duration_seconds)`,
  ]);
}

async function insertActivities(client: ClickHouseClient, rows: ActivityRow[]): Promise<void> {
  await Promise.all([
    client.insert({
      table: `${schema}.activity_summary_rows`,
      format: "JSONEachRow",
      values: rows.map((row) => ({
        activity_id: row.activityId,
        user_id: userId,
        canonical_type: row.canonicalType ?? "cycling",
        modality: row.modality === undefined ? "road" : row.modality,
        started_at: row.startedAt ?? rideStart,
        ended_at: row.endedAtSeconds === null ? null : timestampAt(row.endedAtSeconds),
        is_deleted: row.isDeleted ?? 0,
        power_sample_count: row.powerSampleCount ?? 61,
        refresh_version: row.refreshVersion ?? 1,
        refreshed_at: row.refreshedAt ?? defaultWatermark,
      })),
    }),
    client.insert({
      table: `${schema}.activity_source_records`,
      format: "JSONEachRow",
      values: rows.map((row) => ({
        activity_id: row.sourceMemberId ?? defaultMemberId(row.activityId),
        group_id: row.activityId,
        user_id: userId,
        provider_id: "strava",
        external_id: row.sourceExternalId ?? defaultExternalId(row.activityId),
        modality: row.modality === undefined ? "road" : row.modality,
        started_at: row.startedAt ?? rideStart,
        ended_at: sourceEndedAt(row),
        raw: row.sourceRaw ?? null,
        priority: 1,
        refresh_version: row.refreshVersion ?? 1,
        is_deleted: row.isDeleted ?? 0,
        refreshed_at: row.sourceRefreshedAt ?? row.refreshedAt ?? defaultWatermark,
      })),
    }),
    insertDedupedMembers(client, dbMembersFromActivities(rows)),
    insertSensorSummaries(
      client,
      rows.map((row) => ({ activityId: row.activityId })),
    ),
  ]);
}

interface DedupedMemberRow {
  activityId: string;
  memberId: string;
  refreshVersion?: number;
  refreshedAt?: string;
  isDeleted?: number;
}

interface SensorSummaryRow {
  activityId: string;
  refreshedAt?: string;
  refreshVersion?: number;
  isDeleted?: number;
}

function dbMembersFromActivities(rows: ActivityRow[]): DedupedMemberRow[] {
  return rows.map((row) => ({
    activityId: row.activityId,
    memberId: row.sourceMemberId ?? defaultMemberId(row.activityId),
    refreshVersion: row.refreshVersion,
    refreshedAt: row.refreshedAt,
    isDeleted: row.isDeleted,
  }));
}

async function insertDedupedMembers(
  client: ClickHouseClient,
  rows: DedupedMemberRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: `${schema}.deduped_activity_members`,
    format: "JSONEachRow",
    values: rows.map((row) => ({
      activity_id: row.activityId,
      user_id: userId,
      member_activity_id: row.memberId,
      refresh_version: row.refreshVersion ?? 1,
      is_deleted: row.isDeleted ?? 0,
      refreshed_at: row.refreshedAt ?? defaultWatermark,
    })),
  });
}

async function insertSensorSummaries(
  client: ClickHouseClient,
  rows: SensorSummaryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: `${schema}.activity_sensor_summary_rows`,
    format: "JSONEachRow",
    values: rows.map((row) => ({
      activity_id: row.activityId,
      user_id: userId,
      is_deleted: row.isDeleted ?? 0,
      source_refresh_version: row.refreshVersion ?? 1,
      refresh_version: row.refreshVersion ?? 1,
      refreshed_at: row.refreshedAt ?? defaultWatermark,
    })),
  });
}

async function insertSamples(client: ClickHouseClient, rows: SampleRow[]): Promise<void> {
  await client.insert({
    table: `${schema}.activity_sensor_sample`,
    format: "JSONEachRow",
    values: rows.map((row) => ({
      activity_id: row.activityId,
      user_id: userId,
      recorded_at: timestampAt(row.offsetSeconds),
      recorded_date: "2026-01-01",
      channel: "power",
      scalar: row.power,
      provider_id: row.providerId ?? "strava",
      member_activity_id: row.memberActivityId ?? null,
      device_id: row.deviceId ?? null,
      source_external_id: row.sourceExternalId ?? null,
      source_type: "api",
      source_metric_stream_id: null,
      measurement_kind: row.measurementKind ?? "direct",
      refresh_version: row.refreshVersion ?? 1,
      is_deleted: row.isDeleted ?? 0,
      refreshed_at: row.refreshedAt ?? defaultWatermark,
    })),
  });
}

async function insertSourceRecords(
  client: ClickHouseClient,
  rows: SourceRecordRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: `${schema}.activity_source_records`,
    format: "JSONEachRow",
    values: rows.map((row) => ({
      activity_id: row.activityId,
      group_id: row.groupId,
      user_id: userId,
      provider_id: row.providerId ?? "strava",
      external_id: row.externalId ?? defaultExternalId(row.activityId),
      modality: "road",
      started_at: row.startedAt ?? rideStart,
      ended_at: row.endedAtSeconds === null ? null : timestampAt(row.endedAtSeconds ?? 61),
      raw: row.raw ?? null,
      priority: row.priority ?? 1,
      refresh_version: row.refreshVersion ?? 1,
      is_deleted: row.isDeleted ?? 0,
      refreshed_at: row.refreshedAt ?? defaultWatermark,
    })),
  });
}

async function candidatesFor(
  client: ClickHouseClient,
  activityId: string,
  durationSeconds: number,
) {
  const rows = await effortRows(client, activityId);
  return rows.find((row) => row.duration_seconds === durationSeconds)?.candidates ?? [];
}

async function effortRows(client: ClickHouseClient, activityId: string) {
  const result = await client.query({
    query: `SELECT
        toString(activity_id) AS activity_id,
        duration_seconds,
        candidates,
        is_deleted,
        toString(refresh_version) AS refresh_version,
        toString(refreshed_at) AS refreshed_at
      FROM ${schema}.cycling_durability_effort FINAL
      WHERE activity_id = '${activityId}'
      ORDER BY duration_seconds`,
    format: "JSONEachRow",
  });
  return effortRowsSchema.parse(await result.json());
}

function timestampAt(offsetSeconds: number): string {
  const base = Date.parse("2026-01-01T12:00:00.000Z");
  return new Date(base + offsetSeconds * 1000).toISOString().replace("T", " ").replace("Z", "");
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const [index, statement] of statements.entries()) {
    try {
      await client.command({ query: statement });
    } catch (error) {
      throw new Error(
        `ClickHouse fixture statement ${index + 1} failed: ${statement.replace(/\s+/g, " ").slice(0, 240)}`,
        { cause: error },
      );
    }
  }
}
