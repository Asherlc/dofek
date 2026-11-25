import { ghostSessionsCompareResponseSchema } from "@dofek/training/ghost-sessions";
import { describe, expect, it } from "vitest";
import { type GhostTrackPoint, matchGhostRoutes } from "./ghost-route-matching.ts";
import {
  type GhostSessionScalarObservation,
  measureGhostSession,
  measureGhostSessionScalars,
} from "./ghost-session-measurement.ts";

const degreePerMeter = 180 / (Math.PI * 6_371_000);
const anchorEpochMs = Date.parse("2026-11-24T08:00:00Z");
const candidateEpochMs = Date.parse("2026-11-23T08:00:00Z");

function track(firstMs: number, eastOffset = 0, stepMs = 1_000): GhostTrackPoint[] {
  return Array.from({ length: 21 }, (_, index) => ({
    lat: 0,
    lng: (index * 20 + eastOffset) * degreePerMeter,
    timestampMs: firstMs + index * stepMs,
  }));
}

function verifiedMatch(anchor: GhostTrackPoint[], candidate: GhostTrackPoint[]) {
  const [match] = matchGhostRoutes(anchor, candidate).matches;
  if (!match) throw new Error("Expected verified overlap in the fixture");
  return match;
}

function sample(timestampMs: number, value: number | null): GhostSessionScalarObservation {
  return { recordedAt: new Date(timestampMs).toISOString(), value };
}

function samples(firstMs: number, count: number, value: number): GhostSessionScalarObservation[] {
  return Array.from({ length: count }, (_, index) => sample(firstMs + index * 1_000, value));
}

function pausedRide() {
  const original = track(candidateEpochMs);
  const stop = original[10];
  if (!stop) throw new Error("Expected a recorded stop");
  const candidate = [
    ...original.slice(0, 11),
    { ...stop, timestampMs: stop.timestampMs + 10_000 },
    ...original.slice(11).map((point) => ({ ...point, timestampMs: point.timestampMs + 10_000 })),
  ];
  return verifiedMatch(track(anchorEpochMs), candidate);
}

describe("measureGhostSession", () => {
  it("measures whole-second UTC timestamps and treats invalid native sensor values as barriers", () => {
    const match = pausedRide();
    const nativeSeconds = samples(anchorEpochMs, 20, 120).map(({ recordedAt, value }) => ({
      recordedAt: recordedAt.replace(".000Z", "Z"),
      value,
    }));
    const power = samples(candidateEpochMs, 30, 200);
    const invalidObservations = [null, -8, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of invalidObservations) {
      const invalidPower = power.map((reading, index) => ({
        ...reading,
        value: index >= 10 && index <= 14 ? value : reading.value,
      }));
      expect(
        measureGhostSessionScalars(
          match,
          { heartRateBpm: nativeSeconds, powerWatts: samples(anchorEpochMs, 20, 180) },
          { heartRateBpm: samples(candidateEpochMs, 30, 140), powerWatts: invalidPower },
        ),
      ).toEqual({ heartRateBpm: { anchor: 120, candidate: 140 }, powerWatts: null });
    }
    expect(
      measureGhostSessionScalars(
        match,
        { heartRateBpm: samples(anchorEpochMs, 20, 0), powerWatts: samples(anchorEpochMs, 20, 0) },
        { heartRateBpm: samples(candidateEpochMs, 30, 140), powerWatts: power },
      ),
    ).toEqual({ heartRateBpm: null, powerWatts: { anchor: 0, candidate: 200 } });
  });

  it("keeps agreeing duplicate readings and treats conflicting readings as lost coverage", () => {
    const match = pausedRide();
    const candidate = { powerWatts: samples(candidateEpochMs, 30, 200) };
    const earlier = samples(anchorEpochMs, 20, 120);
    const duplicates = (value: number) =>
      earlier.flatMap((reading, index) =>
        index >= 8 && index <= 11 ? [reading, { ...reading, value }] : [reading],
      );
    expect(measureGhostSessionScalars(match, { powerWatts: duplicates(120) }, candidate)).toEqual({
      heartRateBpm: null,
      powerWatts: { anchor: 120, candidate: 200 },
    });
    expect(measureGhostSessionScalars(match, { powerWatts: duplicates(121) }, candidate)).toEqual({
      heartRateBpm: null,
      powerWatts: null,
    });
  });

  it("keeps an in-bounds zero-power ride well past the first minute", () => {
    const hourTrack = (firstMs: number) =>
      Array.from({ length: 3_601 }, (_, index) => ({
        lng: index * 8 * degreePerMeter,
        lat: 0,
        timestampMs: firstMs + index * 1_000,
      }));
    const match = verifiedMatch(hourTrack(anchorEpochMs), hourTrack(candidateEpochMs));
    expect(match.anchor.elapsedMs).toBe(3_600_000);
    expect(
      measureGhostSessionScalars(
        match,
        { powerWatts: samples(anchorEpochMs, 3_600, 0) },
        { powerWatts: samples(candidateEpochMs, 3_600, 190) },
      ),
    ).toEqual({ heartRateBpm: null, powerWatts: { anchor: 0, candidate: 190 } });
  });

  it("requires at least one complete second and accepts a channel at the observation limit", () => {
    const { anchor, candidate } = pausedRide();
    const oneSecond = (interval: typeof anchor, elapsedMs: number) => ({
      ...interval,
      end: { ...interval.end, timestampMs: interval.start.timestampMs + elapsedMs },
      elapsedMs,
    });
    const observations = {
      heartRateBpm: Array.from({ length: 50_000 }, () => sample(anchorEpochMs, 125)),
    };
    expect(
      measureGhostSessionScalars(
        { anchor: oneSecond(anchor, 1_000), candidate: oneSecond(candidate, 1_000) },
        observations,
        { heartRateBpm: [sample(candidateEpochMs, 130)] },
      ).heartRateBpm,
    ).toEqual({ anchor: 125, candidate: 130 });
    expect(
      measureGhostSessionScalars(
        { anchor: oneSecond(anchor, 999), candidate: oneSecond(candidate, 1_000) },
        { heartRateBpm: [sample(anchorEpochMs, 125)] },
        { heartRateBpm: [sample(candidateEpochMs, 130)] },
      ).heartRateBpm,
    ).toBeNull();
  });

  it("preserves a real match's shared-portion timing, coordinates, and signed run comparison", () => {
    const match = verifiedMatch(track(anchorEpochMs), track(candidateEpochMs, 10, 2_000));
    const result = measureGhostSession({
      match,
      sport: "running",
      anchorObservations: {},
      candidateObservations: {},
    });
    expect(ghostSessionsCompareResponseSchema.parse(result)).toEqual(result);
    expect(result.anchor).toEqual(match.anchor);
    expect(result.candidate).toEqual(match.candidate);
    expect(result.replay).toEqual(match.replay);
    expect(result.replayDownsampled).toBe(match.replayDownsampled);
    expect(result).toMatchObject({
      anchor: { elapsedMs: 19_500 },
      candidate: { elapsedMs: 39_000 },
      elapsedDifferenceMs: -19_500,
      timeBasis: "elapsed-including-recorded-stops",
      metrics: { heartRateBpm: null, powerWatts: null },
    });
    expect(result.metrics.paceSecondsPerKm?.anchor).toBeCloseTo(50, 10);
    expect(result.metrics.paceSecondsPerKm?.candidate).toBeCloseTo(100, 10);
  });

  it("uses one conservative measured distance when the two GPS paths have different lengths", () => {
    const candidate = track(candidateEpochMs, 0, 2_000).map((point, index) => ({
      ...point,
      lat: index === 0 || index === 20 ? 0 : (index % 2 === 0 ? 4 : -4) * degreePerMeter,
    }));
    const match = verifiedMatch(track(anchorEpochMs), candidate);
    expect(
      match.candidate.end.distanceMeters - match.candidate.start.distanceMeters,
    ).toBeGreaterThan(410);
    const result = measureGhostSession({
      match,
      sport: "running",
      anchorObservations: {},
      candidateObservations: {},
    });
    expect(result.metrics.paceSecondsPerKm?.anchor).toBeCloseTo(50, 10);
    expect(result.metrics.paceSecondsPerKm?.candidate).toBeCloseTo(100, 10);
  });

  it("subtracts the earlier pass's approach distance before computing shared running pace", () => {
    const match = verifiedMatch(track(anchorEpochMs, 10, 2_000), track(candidateEpochMs));
    expect(match.candidate.start.distanceMeters).toBeCloseTo(10, 10);
    const result = measureGhostSession({
      match,
      sport: "running",
      anchorObservations: {},
      candidateObservations: {},
    });
    expect(result.metrics.paceSecondsPerKm?.anchor).toBeCloseTo(100, 10);
    expect(result.metrics.paceSecondsPerKm?.candidate).toBeCloseTo(50, 10);
  });

  it("preserves a recorded ride stop and computes clipped time-weighted sensor means with zero power", () => {
    const match = pausedRide();
    const result = measureGhostSession({
      match,
      sport: "cycling",
      anchorObservations: {
        heartRateBpm: [
          sample(anchorEpochMs - 1_000, 999),
          sample(anchorEpochMs, 120),
          sample(anchorEpochMs + 250, 160),
          ...samples(anchorEpochMs + 1_000, 19, 160),
          sample(anchorEpochMs + 20_000, 999),
        ],
        powerWatts: samples(anchorEpochMs, 20, 0),
      },
      candidateObservations: {
        heartRateBpm: samples(candidateEpochMs, 30, 140),
        powerWatts: [
          ...samples(candidateEpochMs, 10, 240),
          ...samples(candidateEpochMs + 10_000, 20, 300),
        ],
      },
    });
    expect(result).toMatchObject({
      anchor: { elapsedMs: 20_000 },
      candidate: { elapsedMs: 30_000 },
      elapsedDifferenceMs: -10_000,
      metrics: {
        paceSecondsPerKm: null,
        heartRateBpm: { anchor: 159.5, candidate: 140 },
        powerWatts: { anchor: 0, candidate: 280 },
      },
    });
    expect(
      result.replay
        ?.filter((key) => key.anchor.timestampMs === anchorEpochMs + 10_000)
        .map((key) => key.candidate.timestampMs),
    ).toEqual([candidateEpochMs + 10_000, candidateEpochMs + 20_000]);
  });

  it("omits only the channel missing on the candidate effort", () => {
    const result = measureGhostSession({
      match: pausedRide(),
      sport: "cycling",
      anchorObservations: {
        heartRateBpm: samples(anchorEpochMs, 20, 120),
        powerWatts: samples(anchorEpochMs, 20, 80),
      },
      candidateObservations: { powerWatts: samples(candidateEpochMs, 30, 90) },
    });
    expect(result.metrics).toEqual({
      paceSecondsPerKm: null,
      heartRateBpm: null,
      powerWatts: { anchor: 80, candidate: 90 },
    });
  });

  it("omits power estimated on one effort despite complete recorded heart rate", () => {
    const result = measureGhostSession({
      match: pausedRide(),
      sport: "cycling",
      anchorObservations: {
        heartRateBpm: samples(anchorEpochMs, 20, 120),
        powerWatts: samples(anchorEpochMs, 20, 80),
      },
      candidateObservations: {
        heartRateBpm: samples(candidateEpochMs, 30, 140),
        powerWatts: samples(candidateEpochMs, 30, 90).map((point) => ({
          ...point,
          isEstimated: true,
        })),
      },
    });
    expect(result.metrics).toEqual({
      paceSecondsPerKm: null,
      heartRateBpm: { anchor: 120, candidate: 140 },
      powerWatts: null,
    });
  });

  it("rejects heart rate with a long candidate dropout and accepts exactly 90 percent coverage", () => {
    const match = pausedRide();
    const anchorObservations = {
      heartRateBpm: samples(anchorEpochMs, 20, 120),
      powerWatts: samples(anchorEpochMs, 20, 80),
    };
    const powerWatts = samples(candidateEpochMs, 30, 90);
    const dropout = measureGhostSession({
      match,
      sport: "cycling",
      anchorObservations,
      candidateObservations: {
        powerWatts,
        heartRateBpm: [
          ...samples(candidateEpochMs, 10, 140),
          ...samples(candidateEpochMs + 20_000, 10, 140),
        ],
      },
    });
    expect(dropout.metrics).toEqual({
      paceSecondsPerKm: null,
      heartRateBpm: null,
      powerWatts: { anchor: 80, candidate: 90 },
    });
    const threshold = measureGhostSession({
      match,
      sport: "cycling",
      anchorObservations,
      candidateObservations: { powerWatts, heartRateBpm: samples(candidateEpochMs, 27, 140) },
    });
    expect(threshold.metrics.heartRateBpm).toEqual({ anchor: 120, candidate: 140 });
  });

  it("uses microseconds when clipping and weighting a fractional GPS boundary", () => {
    const match = verifiedMatch(track(anchorEpochMs + 0.125), track(candidateEpochMs));
    const result = measureGhostSession({
      match,
      sport: "cycling",
      anchorObservations: {
        heartRateBpm: [
          { recordedAt: "2026-11-24T08:00:00.000124Z", value: 999 },
          { recordedAt: "2026-11-24T08:00:00.000125Z", value: 100 },
          { recordedAt: "2026-11-24T08:00:00.500125Z", value: 180 },
          ...samples(anchorEpochMs + 1_000, 19, 180).map((point) => ({
            ...point,
            recordedAt: point.recordedAt.replace(".000Z", ".000125Z"),
          })),
        ],
      },
      candidateObservations: { heartRateBpm: samples(candidateEpochMs, 20, 140) },
    });
    expect(result.anchor.start.timestampMs).toBe(anchorEpochMs + 0.125);
    expect(result.anchor.elapsedMs).toBe(20_000);
    expect(result.metrics.heartRateBpm).toEqual({ anchor: 178, candidate: 140 });
  });

  it("uses an in-window trailing observation to establish the last complete second", () => {
    const match = verifiedMatch(
      track(anchorEpochMs, 0, 1_050).slice(0, 11),
      track(candidateEpochMs, 0, 1_050).slice(0, 11),
    );
    const input = {
      match,
      sport: "cycling",
      candidateObservations: { heartRateBpm: samples(candidateEpochMs, 11, 140) },
    } as const;
    const readings = [
      ...samples(anchorEpochMs, 9, 100),
      sample(anchorEpochMs + 8_500, 180),
      sample(anchorEpochMs + 10_600, 999),
    ];
    const result = measureGhostSession({
      ...input,
      anchorObservations: { heartRateBpm: [...readings, sample(anchorEpochMs + 10_100, 260)] },
    });
    expect(result.anchor.elapsedMs).toBe(10_500);
    expect(result.metrics.heartRateBpm).toEqual({ anchor: 112, candidate: 140 });
    expect(
      measureGhostSession({ ...input, anchorObservations: { heartRateBpm: readings } }).metrics
        .heartRateBpm,
    ).toBeNull();
  });

  it("keeps verified timing when an observation lacks required timestamp seconds", () => {
    const result = measureGhostSession({
      match: pausedRide(),
      sport: "cycling",
      anchorObservations: { powerWatts: samples(anchorEpochMs, 20, 80) },
      candidateObservations: {
        powerWatts: [
          { recordedAt: "2026-11-23T08:00Z", value: 90 },
          ...samples(candidateEpochMs, 30, 90),
        ],
      },
    });
    expect(result.elapsedDifferenceMs).toBe(-10_000);
    expect(result.metrics.powerWatts).toBeNull();
  });

  it("keeps timing and other channels when one channel exceeds the scalar budget", () => {
    const match = pausedRide();
    const result = measureGhostSession({
      match,
      sport: "cycling",
      anchorObservations: {
        heartRateBpm: samples(anchorEpochMs, 20, 120),
        powerWatts: samples(anchorEpochMs, 20, 80),
      },
      candidateObservations: {
        heartRateBpm: samples(candidateEpochMs, 30, 140),
        powerWatts: Array.from({ length: 50_001 }, () => sample(candidateEpochMs, 90)),
      },
    });
    expect(result.elapsedDifferenceMs).toBe(-10_000);
    expect(result.metrics).toEqual({
      paceSecondsPerKm: null,
      heartRateBpm: { anchor: 120, candidate: 140 },
      powerWatts: null,
    });
  });
});
