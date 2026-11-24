import { describe, expect, it } from "vitest";
import {
  type GhostTrackPoint,
  matchGhostRoutes,
  recordedGhostRouteChunks,
  summarizeGhostTrack,
} from "./ghost-route-matching.ts";

const degreePerMeter = 180 / (Math.PI * 6_371_000);

function point(east: number, north: number, timestampMs: number): GhostTrackPoint {
  return { lat: north * degreePerMeter, lng: east * degreePerMeter, timestampMs };
}

function line(start: number, end: number, north = 0, firstMs = 0, stepMs = 1_000) {
  const step = Math.sign(end - start) * 20;
  return Array.from({ length: Math.abs(end - start) / 20 + 1 }, (_, index) =>
    point(start + index * step, north, firstMs + index * stepMs),
  );
}

function denseRun(amplitude: number, seed: number, firstMs = 0, stepMs = 1_000, offsetMeters = 0) {
  const longitudeDegreePerMeter = degreePerMeter / Math.cos((37.77 * Math.PI) / 180);
  return Array.from({ length: 601 }, (_, index) => ({
    lat: 37.77 + degreePerMeter * amplitude * Math.sin(index * 1.7 + seed),
    lng: -122.42 + (index * 3 + offsetMeters) * longitudeDegreePerMeter,
    timestampMs: firstMs + index * stepMs,
  }));
}

function addPauses(track: readonly GhostTrackPoint[], pauses: ReadonlyMap<number, number>) {
  let elapsedPauseMs = 0;
  return track.flatMap((sample, index) => {
    const arrival = { ...sample, timestampMs: sample.timestampMs + elapsedPauseMs };
    const pause = pauses.get(index);
    if (pause === undefined) return [arrival];
    elapsedPauseMs += pause;
    return [arrival, { ...arrival, timestampMs: arrival.timestampMs + pause }];
  });
}

function trace(points: readonly (readonly [number, number])[], startVertex = 0, laps = 1) {
  const path: GhostTrackPoint[] = [];
  for (let index = 0; index < points.length * laps; index += 1) {
    const from = points[(startVertex + index) % points.length];
    const to = points[(startVertex + index + 1) % points.length];
    if (!from || !to) throw new Error("Expected a corner");
    for (let sample = 0; sample < 10; sample += 1) {
      path.push(
        point(
          from[0] + ((to[0] - from[0]) * sample) / 10,
          from[1] + ((to[1] - from[1]) * sample) / 10,
          path.length * 1_000,
        ),
      );
    }
  }
  const endpoint = points[startVertex];
  if (!endpoint) throw new Error("Expected a start vertex");
  path.push(point(...endpoint, path.length * 1_000));
  return path;
}

const square = [
  [0, 0],
  [200, 0],
  [200, 200],
  [0, 200],
] as const;

describe("recordedGhostRouteChunks", () => {
  it("keeps exact original endpoints and stationary readings and respects raw and cadence barriers", () => {
    const first = point(0, 0, 0.125);
    const arrival = point(20, 0, 1_000.125);
    const stop = point(20, 0, 11_000.125);
    const sameTimestamp = { ...stop };
    const moved = point(40, 0, 12_000.125);
    const cadenceSplit = point(100, 0, 32_000.125);
    const following = point(120, 0, 33_000.125);
    const gap = { lat: null, lng: null, timestampMs: 34_000.125 };
    const afterGap = point(150, 0, 35_000.125);
    const last = point(170, 0, 36_000.125);
    const finalStop = point(170, 0, 37_000.125);
    expect(
      recordedGhostRouteChunks([
        first,
        arrival,
        stop,
        sameTimestamp,
        moved,
        cadenceSplit,
        following,
        gap,
        afterGap,
        last,
        finalStop,
      ]),
    ).toMatchObject({
      bounded: false,
      chunks: [
        [
          { ...first, originalIndex: 0, distanceMeters: 0 },
          { ...arrival, originalIndex: 1 },
          { ...stop, originalIndex: 2 },
          { ...moved, originalIndex: 4 },
        ],
        [
          { ...cadenceSplit, originalIndex: 5 },
          { ...following, originalIndex: 6 },
        ],
        [
          { ...afterGap, originalIndex: 8 },
          { ...last, originalIndex: 9 },
          { ...finalStop, originalIndex: 10 },
        ],
      ],
    });
  });

  it("exposes the inherited point limit and leaves out-of-order data without valid chunks", () => {
    const origin = point(0, 0, 0);
    expect(recordedGhostRouteChunks(Array.from({ length: 20_001 }, () => origin))).toEqual({
      chunks: [],
      bounded: true,
    });
    expect(recordedGhostRouteChunks([point(20, 0, 1_000), origin])).toEqual({
      chunks: [],
      bounded: false,
    });
  });
});

describe("summarizeGhostTrack", () => {
  it("retains endpoints and exact timing when the recorded route geometry is downsampled", () => {
    const points = line(0, 4_000);
    const summary = summarizeGhostTrack(points);
    expect(summary).toMatchObject({
      gpsCoverage: "complete",
      anchor: {
        start: { timestampMs: 0, distanceMeters: 0 },
        end: { timestampMs: 200_000 },
        elapsedMs: 200_000,
      },
    });
    expect(summary.geometry).toHaveLength(1);
    expect(summary.geometry[0]).toHaveLength(96);
    expect(summary.geometry[0]?.[0]).toEqual({ lat: 0, lng: 0 });
    expect(summary.geometry[0]?.at(-1)?.lng).toBeCloseTo(4_000 * degreePerMeter, 12);
  });

  it("retains separate recorded chunks when a continuous timed route is unavailable", () => {
    const summary = summarizeGhostTrack([
      ...line(0, 140),
      { lat: null, lng: null, timestampMs: 8_000 },
      ...line(200, 400, 0, 9_000),
    ]);
    expect(summary).toMatchObject({ gpsCoverage: "partial", anchor: null });
    expect(summary.geometry).toHaveLength(2);
    expect(summary.geometry[0]?.at(-1)?.lng).toBeCloseTo(140 * degreePerMeter, 12);
    expect(summary.geometry[1]?.[0]?.lng).toBeCloseTo(200 * degreePerMeter, 12);
  });
});

describe("matchGhostRoutes", () => {
  it.each([
    [1, 1],
    [3, 3],
    [0, 3],
  ])("times a dense 1.8 km run with independent GPS wobble of %i m and %i m", (left, right) => {
    const anchor = denseRun(left, 1);
    const candidate = denseRun(right, 5, 62_000, 1_050);
    const result = matchGhostRoutes(anchor, candidate);
    expect(result).toMatchObject({
      status: "complete",
      anchorCoverage: "complete",
      candidateCoverage: "complete",
    });
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match?.kind).toBe("full-route");
    expect(Math.abs((match?.anchor.elapsedMs ?? 0) - 600_000)).toBeLessThan(1_000);
    expect(Math.abs((match?.candidate.elapsedMs ?? 0) - 630_000)).toBeLessThan(1_000);
    expect(Math.abs((match?.elapsedDifferenceMs ?? 0) + 30_000)).toBeLessThan(1_000);
    for (const pair of match?.replay ?? []) {
      for (const [position, track, offset, step] of [
        [pair.anchor, anchor, 0, 1_000],
        [pair.candidate, candidate, 62_000, 1_050],
      ] as const) {
        const sample = (position.timestampMs - offset) / step;
        const start = track[Math.floor(sample)];
        const end = track[Math.ceil(sample)];
        expect(start).toBeDefined();
        expect(end).toBeDefined();
        if (start && end) {
          const fraction = sample - Math.floor(sample);
          expect(position.lat).toBeCloseTo(start.lat + fraction * (end.lat - start.lat), 10);
          expect(position.lng).toBeCloseTo(start.lng + fraction * (end.lng - start.lng), 10);
        }
      }
    }
  });

  it("rejects separate noisy parallel tracks and a noisy reversed traversal", () => {
    const anchor = denseRun(3, 1);
    const candidate = denseRun(3, 5);
    const parallel = candidate.map((sample) => ({
      ...sample,
      lat: sample.lat + 10 * degreePerMeter,
    }));
    const reversed = [...candidate].reverse().map((sample, index) => ({
      ...sample,
      timestampMs: index * 1_000,
    }));
    expect(matchGhostRoutes(anchor, parallel).matches).toEqual([]);
    expect(matchGhostRoutes(anchor, reversed).matches).toEqual([]);
  });

  it("matches a dense noisy run with a one-meter sample offset along the course", () => {
    const anchor = denseRun(3, 1);
    const candidate = denseRun(3, 5, 62_000, 1_050, 1);
    const result = matchGhostRoutes(anchor, candidate);
    expect(result).toMatchObject({
      status: "complete",
      anchorCoverage: "complete",
      candidateCoverage: "complete",
    });
    expect(result.matches.map((match) => match.kind)).toEqual(["full-route"]);
    const [match] = result.matches;
    expect(Math.abs((match?.anchor.elapsedMs ?? 0) - 600_000)).toBeLessThan(1_000);
    expect(Math.abs((match?.candidate.elapsedMs ?? 0) - 630_000)).toBeLessThan(1_000);
    expect(match?.candidate.start).toMatchObject(candidate[0] ?? {});
    expect(match?.anchor.end).toMatchObject(anchor.at(-1) ?? {});
  });

  it("keeps dense noisy overlaps on either side of a raw recording gap", () => {
    const anchor = denseRun(3, 1);
    const candidate = denseRun(3, 5).map((sample, index) => ({
      ...sample,
      timestampMs: sample.timestampMs + (index >= 300 ? 31_000 : 0),
    }));
    const result = matchGhostRoutes(anchor, candidate);
    expect(result.candidateCoverage).toBe("partial");
    expect(result.matches.map((match) => match.kind)).toEqual(["shared-stretch", "shared-stretch"]);
    expect(result.matches[0]?.candidate.end.timestampMs).toBeLessThanOrEqual(299_000);
    expect(result.matches[1]?.candidate.start.timestampMs).toBeGreaterThanOrEqual(331_000);
  });

  it("times common full-route boundaries with small recording shifts and independently sampled positions", () => {
    const result = matchGhostRoutes(line(0, 300), line(10, 310, 0, 60_000, 2_000));
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match).toMatchObject({
      kind: "full-route",
      anchor: { start: { timestampMs: 500 }, end: { timestampMs: 15_000 }, elapsedMs: 14_500 },
      candidate: {
        start: { timestampMs: 60_000 },
        end: { timestampMs: 89_000 },
        elapsedMs: 29_000,
      },
      elapsedDifferenceMs: -14_500,
    });
    expect(match?.anchor.start.lng).toBeCloseTo(10 * degreePerMeter, 12);
    expect(match?.candidate.end.lng).toBeCloseTo(300 * degreePerMeter, 12);
    expect(match?.replay[0]).toEqual({
      anchor: match?.anchor.start,
      candidate: match?.candidate.start,
    });
    expect(match?.replay.at(-1)).toEqual({
      anchor: match?.anchor.end,
      candidate: match?.candidate.end,
    });
    const step = match?.replay[1];
    expect(step?.anchor.lng).toBeCloseTo(20 * degreePerMeter, 12);
    expect(step?.candidate.lng).toBeCloseTo(20 * degreePerMeter, 12);
    expect(step?.anchor.timestampMs).toBe(1_000);
    expect(step?.candidate.timestampMs).toBe(61_000);
  });

  it("keeps a recorded stationary pause in elapsed time, with monotone replay", () => {
    const anchor = line(0, 300);
    const candidate = [
      ...line(0, 140, 0, 20_000),
      point(140, 0, 36_000),
      ...line(160, 300, 0, 37_000),
    ];
    const [match] = matchGhostRoutes(anchor, candidate).matches;
    expect(match).toMatchObject({
      anchor: { elapsedMs: 15_000 },
      candidate: { elapsedMs: 24_000 },
      elapsedDifferenceMs: -9_000,
    });
    expect(
      match?.replay.find((step) => step.candidate.timestampMs === 36_000)?.anchor.lng,
    ).toBeCloseTo(140 * degreePerMeter, 12);
    for (const [index, step] of (match?.replay ?? []).entries()) {
      const prior = match?.replay[index - 1];
      if (!prior) continue;
      for (const side of ["anchor", "candidate"] as const) {
        expect(step[side].timestampMs).toBeGreaterThanOrEqual(prior[side].timestampMs);
        expect(step[side].distanceMeters).toBeGreaterThanOrEqual(prior[side].distanceMeters);
      }
    }
  });

  it("matches a short shared stretch in much longer different tracks", () => {
    const candidate = [
      ...Array.from({ length: 10 }, (_, index) => point(400, (10 - index) * 20, index * 2_000)),
      ...line(400, 560, 0, 20_000, 2_000),
      ...Array.from({ length: 10 }, (_, index) =>
        point(560, -(index + 1) * 20, 38_000 + index * 2_000),
      ),
    ];
    const anchor = line(0, 1_800);
    const result = matchGhostRoutes(anchor, candidate);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      kind: "shared-stretch",
      anchor: { start: { timestampMs: 20_000 }, end: { timestampMs: 28_000 }, elapsedMs: 8_000 },
      candidate: {
        start: { timestampMs: 20_000 },
        end: { timestampMs: 36_000 },
        elapsedMs: 16_000,
      },
      elapsedDifferenceMs: -8_000,
    });
    const [secondOverlap] = matchGhostRoutes(anchor, line(500, 680)).matches;
    expect(secondOverlap?.anchor.start.timestampMs).toBe(25_000);
    expect(secondOverlap?.anchor.end.timestampMs).toBe(34_000);
  });

  it("rejects a reverse line and a reversed closed loop", () => {
    expect(matchGhostRoutes(line(0, 300), line(300, 0)).matches).toEqual([]);
    expect(
      matchGhostRoutes(trace(square), trace([square[0], square[3], square[2], square[1]])).matches,
    ).toEqual([]);
  });

  it("accepts a same-start loop as full and offsets a shifted loop into continuous shared stretches", () => {
    const loop = trace(square);
    expect(matchGhostRoutes(loop, loop).matches.map((match) => match.kind)).toEqual(["full-route"]);
    const shifted = matchGhostRoutes(loop, trace(square, 1));
    expect(
      shifted.matches.map((match) => [
        match.kind,
        match.anchor.start.timestampMs,
        match.anchor.elapsedMs,
        match.candidate.start.timestampMs,
        match.candidate.elapsedMs,
      ]),
    ).toEqual([
      ["shared-stretch", 0, 10_000, 30_000, 10_000],
      ["shared-stretch", 10_000, 30_000, 0, 30_000],
    ]);
  });

  it("keeps duplicate laps as separate shared passes with their original intervals", () => {
    const result = matchGhostRoutes(trace(square), trace(square, 0, 2));
    expect(
      result.matches.map((match) => [
        match.kind,
        match.candidate.start.timestampMs,
        match.candidate.end.timestampMs,
      ]),
    ).toEqual([
      ["shared-stretch", 0, 40_000],
      ["shared-stretch", 40_000, 80_000],
    ]);
  });

  it("keeps distinct two-lap passes whose recorded windows overlap", () => {
    const result = matchGhostRoutes(trace(square, 0, 2), trace(square, 0, 3));
    expect(
      result.matches.map((match) => [
        match.kind,
        match.anchor.start.timestampMs,
        match.anchor.end.timestampMs,
        match.candidate.start.timestampMs,
        match.candidate.end.timestampMs,
      ]),
    ).toEqual([
      ["shared-stretch", 0, 80_000, 0, 80_000],
      ["shared-stretch", 0, 80_000, 40_000, 120_000],
      ["shared-stretch", 0, 40_000, 80_000, 120_000],
      ["shared-stretch", 40_000, 80_000, 0, 40_000],
    ]);
  });

  it("keeps cross-lap shares alongside the full two-lap comparison", () => {
    const twoLaps = trace(square, 0, 2);
    const withLapTimes = (firstMs: number, lastMs: number) =>
      twoLaps.map((sample, index) => ({
        ...sample,
        timestampMs: index <= 40 ? (index * firstMs) / 40 : firstMs + ((index - 40) * lastMs) / 40,
      }));
    const result = matchGhostRoutes(withLapTimes(40_000, 50_000), withLapTimes(60_000, 70_000));
    expect(
      result.matches.map((match) => [
        match.kind,
        match.anchor.start.timestampMs,
        match.anchor.end.timestampMs,
        match.candidate.start.timestampMs,
        match.candidate.end.timestampMs,
      ]),
    ).toEqual([
      ["full-route", 0, 90_000, 0, 130_000],
      ["shared-stretch", 0, 40_000, 60_000, 130_000],
      ["shared-stretch", 40_000, 90_000, 0, 60_000],
    ]);
  });

  it("finds repeated forward passes inside one operation and preserves a complete out-and-back", () => {
    const operation = [...line(0, 300), ...line(300, 0, 0, 16_000), ...line(0, 300, 0, 32_000)];
    const repeated = matchGhostRoutes(line(0, 300), operation);
    expect(
      repeated.matches.map((match) => [
        match.kind,
        match.candidate.start.timestampMs,
        match.candidate.end.timestampMs,
      ]),
    ).toEqual([
      ["shared-stretch", 0, 15_000],
      ["shared-stretch", 32_000, 47_000],
    ]);
    const outAndBack = operation.slice(0, 32);
    expect(matchGhostRoutes(outAndBack, outAndBack).matches.map((match) => match.kind)).toEqual([
      "full-route",
    ]);
  });

  it.each([10, 15, 20])(
    "rejects a path that crosses and then runs %i m to either side",
    (offset) => {
      const candidate = [
        ...line(0, 140, offset),
        point(150, 0, 8_000),
        ...line(160, 300, -offset, 9_000),
      ];
      expect(matchGhostRoutes(line(0, 300), candidate).matches).toEqual([]);
    },
  );

  it("accepts a consistent five-meter recording offset and rejects a perpendicular crossing", () => {
    expect(matchGhostRoutes(line(0, 300), line(0, 300, 5)).matches[0]?.kind).toBe("full-route");
    const crossing = Array.from({ length: 21 }, (_, index) =>
      point(140, index * 20 - 200, index * 1_000),
    );
    expect(matchGhostRoutes(line(0, 300), crossing).matches).toEqual([]);
  });

  it("accepts brief eight-meter noise but rejects sustained drift of the same size", () => {
    const anchor = line(0, 400);
    const candidate = line(0, 400);
    candidate[10] = point(200, 8, 10_000);
    expect(matchGhostRoutes(anchor, candidate).matches[0]?.kind).toBe("full-route");
    expect(matchGhostRoutes(anchor, line(0, 400, 8)).matches).toEqual([]);
  });

  it("breaks an otherwise timed overlap when a single excursion exceeds the lateral cap", () => {
    const candidate = line(0, 400);
    candidate[10] = point(200, 10, 10_000);
    expect(
      matchGhostRoutes(line(0, 400), candidate).matches.map((match) => [
        match.anchor.start.timestampMs,
        match.anchor.end.timestampMs,
      ]),
    ).toEqual([
      [0, 9_000],
      [11_000, 20_000],
    ]);
  });

  it("limits timing to intervals on either side of missing, time-gap, and distance-gap readings", () => {
    const anchor = line(0, 400);
    const candidate = [
      ...line(0, 160),
      { lat: null, lng: null, timestampMs: 9_000 },
      ...line(180, 400, 0, 10_000),
    ];
    const missing = matchGhostRoutes(anchor, candidate);
    expect(missing.candidateCoverage).toBe("partial");
    expect(
      missing.matches.map((match) => [
        match.kind,
        match.anchor.start.timestampMs,
        match.anchor.end.timestampMs,
        match.candidate.elapsedMs,
      ]),
    ).toEqual([
      ["shared-stretch", 0, 8_000, 8_000],
      ["shared-stretch", 9_000, 20_000, 11_000],
    ]);

    const timeGap = matchGhostRoutes(anchor, [...line(0, 160), ...line(180, 400, 0, 39_000)]);
    expect(timeGap.candidateCoverage).toBe("partial");
    expect(timeGap.matches[1]?.candidate.start.timestampMs).toBe(39_000);

    const distanceGap = matchGhostRoutes(anchor, [...line(0, 140), ...line(240, 400, 0, 20_000)]);
    expect(distanceGap.candidateCoverage).toBe("partial");
    expect(distanceGap.matches.map((match) => match.candidate.elapsedMs)).toEqual([7_000, 8_000]);

    const reversedCoverage = matchGhostRoutes(candidate, anchor);
    expect(reversedCoverage.anchorCoverage).toBe("partial");
    expect(reversedCoverage.matches.map((match) => match.candidate.elapsedMs)).toEqual([
      8_000, 11_000,
    ]);
  });

  it("rejects out-of-order timestamps for the affected recording", () => {
    const candidate = line(0, 400);
    candidate[10] = point(200, 0, 7_000);
    expect(matchGhostRoutes(line(0, 400), candidate)).toMatchObject({
      candidateCoverage: "unusable",
      matches: [],
    });
  });

  it("does not interpolate a split endpoint inside a 20-second moving dropout at 1 Hz", () => {
    const samples = (from: number, to: number, firstMs: number) =>
      Array.from({ length: (to - from) / 3 + 1 }, (_, index) =>
        point(from + index * 3, 0, firstMs + index * 1_000),
      );
    const anchor = samples(255, 390, 0);
    const candidate = [...samples(0, 210, 0), ...samples(270, 420, 90_000)];
    const result = matchGhostRoutes(anchor, candidate);
    expect(result.matches).toMatchObject([
      {
        kind: "shared-stretch",
        anchor: { start: { timestampMs: 5_000 }, elapsedMs: 40_000 },
        candidate: { start: { timestampMs: 90_000 }, elapsedMs: 40_000 },
        elapsedDifferenceMs: 0,
      },
    ]);
    expect(result.candidateCoverage).toBe("partial");
    expect(result.matches[0]?.candidate.start.lng).toBeCloseTo(270 * degreePerMeter, 12);
  });

  it("uses the local cadence on each side of an explicit GPS barrier", () => {
    const anchor = line(0, 540);
    const candidate = [
      ...line(0, 400),
      { lat: null, lng: null, timestampMs: 21_000 },
      ...line(420, 540, 0, 22_000, 6_000),
    ];
    const result = matchGhostRoutes(anchor, candidate);
    expect(result.candidateCoverage).toBe("partial");
    expect(result.matches.map((match) => match.candidate.elapsedMs)).toEqual([20_000, 36_000]);
  });

  it("keeps a 20-second stationary interval in an otherwise 1 Hz recording", () => {
    const anchor = Array.from({ length: 101 }, (_, index) => point(index * 3, 0, index * 1_000));
    const [match] = matchGhostRoutes(anchor, addPauses(anchor, new Map([[50, 20_000]]))).matches;
    expect(match).toMatchObject({
      kind: "full-route",
      anchor: { elapsedMs: 100_000 },
      candidate: { elapsedMs: 120_000 },
    });
    expect(
      match?.replay
        .filter((pair) => pair.anchor.timestampMs === 50_000)
        .map((pair) => pair.candidate.timestampMs),
    ).toEqual([50_000, 70_000]);
  });

  it("treats identical positions at one recorded timestamp as a single observation", () => {
    const track = line(0, 400);
    const duplicate = point(200, 0, 10_000);
    const candidate = [...track.slice(0, 11), duplicate, ...track.slice(11)];
    const result = matchGhostRoutes(track, candidate);
    expect(result.candidateCoverage).toBe("complete");
    expect(result.matches).toMatchObject([
      { kind: "full-route", candidate: { elapsedMs: 20_000 } },
    ]);
  });

  it("treats conflicting positions at one timestamp as a local coverage gap", () => {
    const track = line(0, 400);
    const conflict = point(200, 15, 10_000);
    const candidate = [...track.slice(0, 11), conflict, ...track.slice(11)];
    const result = matchGhostRoutes(track, candidate);
    expect(result.candidateCoverage).toBe("partial");
    expect(
      result.matches.map((match) => [
        match.kind,
        match.candidate.start.timestampMs,
        match.candidate.end.timestampMs,
      ]),
    ).toEqual([
      ["shared-stretch", 0, 9_000],
      ["shared-stretch", 11_000, 20_000],
    ]);
  });

  it("preserves fractional milliseconds on recorded and interpolated boundaries", () => {
    const [match] = matchGhostRoutes(
      line(0, 300, 0, 0.125, 1_000.25),
      line(10, 310, 0, 60_000.625, 2_000.5),
    ).matches;
    expect(match?.anchor.start.timestampMs).toBe(500.25);
    expect(match?.anchor.end.timestampMs).toBe(15_003.875);
    expect(match?.candidate.start.timestampMs).toBe(60_000.625);
    expect(match?.candidate.end.timestampMs).toBe(89_007.875);
    expect(match?.elapsedDifferenceMs).toBe(-14_503.625);
  });

  it("marks a complete route beyond the coarse matcher's work limit as bounded", () => {
    const track = line(0, 220_000);
    expect(matchGhostRoutes(track, track)).toMatchObject({
      status: "bounded",
      anchorCoverage: "complete",
      candidateCoverage: "complete",
    });
  });

  it("bounds replay and route normalization while preserving the last recorded position", () => {
    const result = matchGhostRoutes(line(0, 5_000), line(0, 5_000));
    expect(result.status).toBe("complete");
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match?.kind).toBe("full-route");
    expect(match?.replay.length).toBeLessThan(100);
    expect(match?.replayDownsampled).toBe(true);
    expect(match?.replay.at(-1)?.candidate.timestampMs).toBe(250_000);
  });

  it("retains both recorded keys for a pause when a long replay is downsampled", () => {
    const anchor = line(0, 9_980);
    const [match] = matchGhostRoutes(anchor, addPauses(anchor, new Map([[157, 10_000]]))).matches;
    expect(match).toMatchObject({ replayDownsampled: true, candidate: { elapsedMs: 509_000 } });
    expect(match?.replay.length).toBeLessThanOrEqual(96);
    const keys = match?.replay.filter((pair) => pair.anchor.timestampMs === 157_000);
    expect(keys?.map((key) => key.candidate.timestampMs)).toEqual([157_000, 167_000]);
    expect(keys?.every((key) => key.candidate.lng === key.anchor.lng)).toBe(true);
  });

  it("retains both recorded keys when the stopped and moving tracks have different GPS wobble", () => {
    const anchor = denseRun(3, 1);
    const candidate = addPauses(denseRun(3, 5), new Map([[173, 10_000]]));
    const [match] = matchGhostRoutes(anchor, candidate).matches;
    expect(match?.replayDownsampled).toBe(true);
    const keys = match?.replay.filter((pair) => pair.candidate.lng === candidate[173]?.lng);
    expect(keys?.map((pair) => pair.candidate.timestampMs)).toEqual([173_000, 183_000]);
  });

  it("prioritizes longer stops when all pause keys cannot fit", () => {
    const anchor = line(0, 9_980);
    const pauses = new Map(Array.from({ length: 55 }, (_, index) => [index * 4 + 1, 1_000]));
    pauses.set(377, 10_000);
    const [match] = matchGhostRoutes(anchor, addPauses(anchor, pauses)).matches;
    expect(match).toMatchObject({ replayDownsampled: true, candidate: { elapsedMs: 564_000 } });
    expect(match?.replay.length).toBeLessThanOrEqual(96);
    expect(match?.replay[0]?.candidate.timestampMs).toBe(0);
    expect(match?.replay.at(-1)?.candidate.timestampMs).toBe(564_000);
    expect(
      match?.replay
        .filter((pair) => pair.anchor.timestampMs === 377_000)
        .map((pair) => pair.candidate.timestampMs),
    ).toEqual([432_000, 442_000]);
  });

  it("reports a bounded result when repeated passes exceed the output limit", () => {
    const result = matchGhostRoutes(trace(square), trace(square, 0, 34));
    expect(result.status).toBe("bounded");
    expect(result.matches).toHaveLength(32);
    expect(new Set(result.matches.map((match) => match.candidate.start.timestampMs)).size).toBe(32);
    expect(result.matches.every((match) => match.candidate.elapsedMs === 40_000)).toBe(true);
  });

  it("reports a bounded result when a crowded cell exhausts the traversal budget", () => {
    const crowdedTrack = Array.from({ length: 700 }, (_, index) =>
      point((index % 2) * 2, 0, index * 1_000),
    );
    expect(matchGhostRoutes(crowdedTrack, crowdedTrack)).toMatchObject({
      status: "bounded",
      anchorCoverage: "complete",
      candidateCoverage: "complete",
      matches: [],
    });
  });

  it("reports a bounded result for exceptionally large input", () => {
    expect(matchGhostRoutes(line(0, 300), line(0, 500_000))).toMatchObject({
      status: "bounded",
      matches: [],
    });
  });
});
