import { describe, expect, it } from "vitest";
import { type GhostTrackPoint, recordedGhostRouteChunks } from "./ghost-route-matching.ts";
import { findUnnamedGhostClimbs, matchGhostRouteSection } from "./ghost-route-sections.ts";

const degreePerMeter = 180 / (Math.PI * 6_371_000);

function point(meters: number, timestampMs: number): GhostTrackPoint {
  return { lat: 0, lng: meters * degreePerMeter, timestampMs };
}

function line(start: number, end: number, startMs: number, intervalMs = 1_000) {
  const step = start <= end ? 20 : -20;
  return Array.from({ length: Math.abs(end - start) / 20 + 1 }, (_, index) =>
    point(start + index * step, startMs + index * intervalMs),
  );
}

function bounds(points: readonly GhostTrackPoint[], startIndex: number, endIndex: number) {
  const refs = recordedGhostRouteChunks(points).chunks.flat();
  const start = refs.find(({ originalIndex }) => originalIndex === startIndex);
  const end = refs.find(({ originalIndex }) => originalIndex === endIndex);
  if (!start || !end) throw new Error("Expected recorded bounds");
  return { start, end };
}

describe("matchGhostRouteSection", () => {
  it("keeps a 128 m, 37 s section at the original cadence across a recorded 6 s interval", () => {
    const sectionIntervals = [2, 2, 2, 3, 2, 3, 2, 6, 2, 3, 2, 3, 2, 3];
    const approach = line(0, 160, 60_000.125, 5_000);
    let timestampMs = 100_000.125;
    const section = sectionIntervals.map((seconds, index) => {
      timestampMs += seconds * 1_000;
      return point(160 + ((index + 1) * 128) / sectionIntervals.length, timestampMs);
    });
    const anchor = [...approach, ...section, ...line(308, 468, 142_000.125, 5_000)];
    const candidate = [
      point(160, 0.375),
      ...section.map((sample, index) => ({
        ...sample,
        timestampMs: (index + 1) * 3_000 + 0.375,
      })),
    ];
    const result = matchGhostRouteSection(anchor, candidate, bounds(anchor, 8, 22));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      anchor: {
        start: { timestampMs: 100_000.125 },
        end: { timestampMs: 137_000.125 },
        elapsedMs: 37_000,
      },
      candidate: {
        start: { timestampMs: 0.375 },
        end: { timestampMs: 42_000.375 },
        elapsedMs: 42_000,
      },
      elapsedDifferenceMs: -5_000,
    });
    expect(
      (result.matches[0]?.anchor.end.distanceMeters ?? 0) -
        (result.matches[0]?.anchor.start.distanceMeters ?? 0),
    ).toBeCloseTo(128, 8);
  });

  it("clips to the actual common portion and preserves off-origin distance and an interior stop", () => {
    const anchor = line(0, 400, 100_000.125).flatMap((sample, index) => {
      if (index === 11) return [sample, { ...sample, timestampMs: sample.timestampMs + 8_000 }];
      return [index > 11 ? { ...sample, timestampMs: sample.timestampMs + 8_000 } : sample];
    });
    const candidate = line(140, 360, 1_000.375, 1_500);
    const moreArea = bounds(anchor, 4, 17);
    const result = matchGhostRouteSection(anchor, candidate, moreArea);
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match).toMatchObject({
      kind: "shared-stretch",
      anchor: {
        start: { timestampMs: 107_000.125 },
        end: { timestampMs: 124_000.125 },
        elapsedMs: 17_000,
      },
      candidate: {
        start: { timestampMs: 1_000.375 },
        end: { timestampMs: 14_500.375 },
        elapsedMs: 13_500,
      },
      elapsedDifferenceMs: 3_500,
    });
    expect(match?.anchor.start.distanceMeters).toBeCloseTo(140, 9);
    expect(match?.anchor.end.distanceMeters).toBeCloseTo(320, 9);
    expect(match?.replay[0]).toEqual({
      anchor: match?.anchor.start,
      candidate: match?.candidate.start,
    });
    expect(match?.replay.at(-1)).toEqual({
      anchor: match?.anchor.end,
      candidate: match?.candidate.end,
    });
    expect(
      match?.replay
        .filter(({ anchor: replayPoint }) => Math.abs(replayPoint.distanceMeters - 220) < 0.000_001)
        .map(({ anchor: replayPoint }) => replayPoint.timestampMs),
    ).toEqual([111_000.125, 119_000.125]);
  });

  it("preserves canonical recorded distance even when the slice uses a different projection origin", () => {
    const north = Array.from({ length: 501 }, (_, index) => ({
      lat: 45 + index * 40 * degreePerMeter,
      lng: 0,
      timestampMs: 100_000 + 2_000 * index,
    }));
    const east = Array.from({ length: 11 }, (_, index) => ({
      lat: 45 + 500 * 40 * degreePerMeter,
      lng: ((index + 1) * 30 * degreePerMeter) / Math.cos(Math.PI / 4),
      timestampMs: 1_102_000 + index * 2_000,
    }));
    const anchor = [...north, ...east];
    const section = bounds(anchor, 501, 511);
    const candidate = east.map((sample, index) => ({ ...sample, timestampMs: index * 1_500 }));
    const result = matchGhostRouteSection(anchor, candidate, section);
    const [match] = result.matches;
    expect(match?.anchor.start).toMatchObject({ distanceMeters: section.start.distanceMeters });
    expect(match?.anchor.end).toMatchObject({ distanceMeters: section.end.distanceMeters });
    expect(match?.candidate.elapsedMs).toBe(15_000);
    expect(match?.replay[0]?.anchor).toEqual(match?.anchor.start);
    expect(match?.replay.at(-1)?.anchor).toEqual(match?.anchor.end);
  });

  it("keeps the exact raw coordinate at a matched timestamp across the antimeridian", () => {
    const longitude = [179.9994, 179.9997, 180, -179.9997, -179.9994, -179.9991];
    const anchor = longitude.map((lng, index) => ({
      lng,
      lat: 0,
      timestampMs: 30_000 + index * 5_000,
    }));
    const candidate = anchor.map((sample) => ({
      ...sample,
      timestampMs: sample.timestampMs - 30_000,
    }));
    const result = matchGhostRouteSection(anchor, candidate, bounds(anchor, 0, 5));
    const [match] = result.matches;
    expect(match?.anchor.end).toMatchObject({ lng: -179.9991, lat: 0, timestampMs: 55_000 });
    expect(match?.replay.at(-1)?.anchor).toEqual(match?.anchor.end);
  });

  it("keeps two earlier same-workout passes and excludes self, later and reversed traversals", () => {
    const points = Array.from({ length: 71 }, (_, index) => {
      const pass = index % 20;
      return point((pass <= 10 ? pass : 20 - pass) * 20, index * 1_000 + 0.125);
    });
    const result = matchGhostRouteSection(points, points, bounds(points, 40, 50));
    expect(
      result.matches.map(({ anchor, candidate }) => [
        anchor.start.timestampMs,
        anchor.end.timestampMs,
        candidate.start.timestampMs,
        candidate.end.timestampMs,
      ]),
    ).toEqual([
      [40_000.125, 50_000.125, 0.125, 10_000.125],
      [40_000.125, 50_000.125, 20_000.125, 30_000.125],
    ]);
  });

  it("recovers the maximal earlier prefix when a same-workout match overlaps the anchor", () => {
    const points = [
      ...line(0, 200, 0),
      ...line(180, 0, 11_000),
      ...line(20, 200, 21_000),
      ...line(180, 0, 31_000),
      ...line(20, 200, 41_000),
    ];
    const result = matchGhostRouteSection(
      points,
      points.map((sample) => ({ ...sample })),
      bounds(points, 20, 50),
    );
    expect(
      result.matches.map(({ anchor, candidate }) => [
        anchor.start.timestampMs,
        anchor.end.timestampMs,
        candidate.start.timestampMs,
        candidate.end.timestampMs,
      ]),
    ).toEqual([
      [20_000, 40_000, 0, 20_000],
      [40_000, 50_000, 0, 10_000],
    ]);
    expect(
      result.matches.every(
        ({ anchor, candidate }) => candidate.end.timestampMs <= anchor.start.timestampMs,
      ),
    ).toBe(true);
    expect(
      result.matches.some(
        ({ candidate }) =>
          candidate.start.timestampMs === 0 && candidate.end.timestampMs === 30_000,
      ),
    ).toBe(false);
  });

  it("retains the original cadence when recovering an earlier same-workout prefix", () => {
    const laps = Array.from({ length: 51 }, (_, index) => {
      const pass = index % 20;
      // The full recording has 5 s cadence and a legitimate 6 s interval.
      // The first out-and-back alone has a 1 s median and would reject it.
      return point((pass <= 10 ? pass : 20 - pass) * 20, index * 1_000 + (index >= 5 ? 5_000 : 0));
    });
    const anchor = [...laps, ...line(220, 1_420, 60_000, 5_000)];
    const result = matchGhostRouteSection(anchor, anchor, bounds(anchor, 20, 50));
    expect(
      result.matches.map(({ anchor, candidate }) => [
        anchor.start.timestampMs,
        anchor.end.timestampMs,
        candidate.start.timestampMs,
        candidate.end.timestampMs,
      ]),
    ).toEqual([
      [25_000, 45_000, 0, 25_000],
      [45_000, 55_000, 0, 15_000],
    ]);
  });

  it("rejects reverse matches and leaves a short labeled span without timed matches", () => {
    const anchor = line(0, 200, 30_000);
    const reverse = matchGhostRouteSection(anchor, line(200, 0, 0), bounds(anchor, 0, 10));
    const short = matchGhostRouteSection(anchor, line(0, 200, 0), bounds(anchor, 0, 3));
    expect(reverse).toMatchObject({
      anchorCoverage: "complete",
      candidateCoverage: "complete",
      matches: [],
    });
    expect(short).toMatchObject({
      anchorCoverage: "complete",
      candidateCoverage: "complete",
      matches: [],
    });
  });

  it("invalidates original refs that no longer agree with the selected anchor", () => {
    const anchor = line(0, 320, 30_000);
    const candidate = line(0, 320, 0);
    const { start, end } = bounds(anchor, 2, 14);
    expect(matchGhostRouteSection(anchor, candidate, { start, end }).matches).toHaveLength(1);
    for (const changed of [
      { ...start, originalIndex: start.originalIndex + 1 },
      { ...start, timestampMs: start.timestampMs + 0.001 },
      { ...start, lat: 0.000_001 },
      { ...start, distanceMeters: start.distanceMeters + 1 },
    ]) {
      expect(matchGhostRouteSection(anchor, candidate, { start: changed, end }).matches).toEqual(
        [],
      );
    }
    expect(matchGhostRouteSection(anchor, candidate, { start: end, end: start }).matches).toEqual(
      [],
    );
  });

  it("cannot cross a GPS gap and keeps the cumulative offset in a later continuous chunk", () => {
    const first = line(0, 160, 30_000);
    const last = line(220, 420, 58_000);
    const anchor = [...first, ...last];
    const prior = line(220, 420, 0);
    expect(matchGhostRouteSection(anchor, prior, bounds(anchor, 0, 19)).matches).toEqual([]);
    const result = matchGhostRouteSection(anchor, prior, bounds(anchor, 9, 19));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.anchor.start.distanceMeters).toBeCloseTo(160, 8);
    expect(result.matches[0]?.anchor.end.distanceMeters).toBeCloseTo(360, 8);
  });

  it("propagates bounds on inputs before claiming complete results", () => {
    const anchor = line(0, 200, 30_000);
    const section = bounds(anchor, 0, 10);
    const tooMany = Array.from({ length: 20_001 }, () => point(0, 0));
    expect(matchGhostRouteSection(tooMany, anchor, section).status).toBe("bounded");
    expect(matchGhostRouteSection(anchor, tooMany, section).status).toBe("bounded");
  });
});

function climb(sampleCount = 41) {
  const points = Array.from({ length: sampleCount }, (_, index) =>
    point(index * 4, index * 1_000 + 0.125),
  );
  const altitude = Array.from({ length: sampleCount }, (_, index) => ({
    timestampMs: index * 1_000 + 0.125,
    altitudeMeters: 100 + index * 0.4,
  }));
  return { points, altitude };
}

describe("findUnnamedGhostClimbs", () => {
  it("accepts the exact four-block, 120 m and 12 m rise thresholds", () => {
    const points = Array.from({ length: 5 }, (_, index) => point(index * 30, index * 2_000));
    const altitude = points.map(({ timestampMs }, index) => ({
      timestampMs,
      altitudeMeters: index * 3,
    }));
    expect(findUnnamedGhostClimbs(points, altitude)).toEqual({
      sections: [bounds(points, 0, 4)],
      bounded: false,
    });
    expect(findUnnamedGhostClimbs(points, altitude.slice(0, 4))).toEqual({
      sections: [],
      bounded: false,
    });
    const below = altitude.map((sample, index) => ({
      ...sample,
      altitudeMeters: index * 2.99,
    }));
    expect(findUnnamedGhostClimbs(points, below)).toEqual({ sections: [], bounded: false });
  });

  it("requires a sustained three percent grade even when a ride gains more than twelve meters", () => {
    const points = Array.from({ length: 9 }, (_, index) => point(index * 50, index * 2_000));
    const elevations = (risePerSample: number) =>
      points.map(({ timestampMs }, index) => ({
        timestampMs,
        altitudeMeters: index * risePerSample,
      }));
    expect(findUnnamedGhostClimbs(points, elevations(1.5))).toEqual({
      sections: [bounds(points, 0, 8)],
      bounded: false,
    });
    expect(findUnnamedGhostClimbs(points, elevations(1.49))).toEqual({
      sections: [],
      bounded: false,
    });
    expect(findUnnamedGhostClimbs(points, elevations(1.01))).toEqual({
      sections: [],
      bounded: false,
    });
  });

  it("includes only altitude times within one second of both recorded GPS brackets", () => {
    const points = Array.from({ length: 11 }, (_, index) => point(index * 20, index * 2_000));
    const altitude = points.slice(0, -1).map(({ timestampMs }, index) => ({
      timestampMs: timestampMs + 1_000,
      altitudeMeters: index * 2,
    }));
    expect(findUnnamedGhostClimbs(points, altitude)).toEqual({
      sections: [bounds(points, 0, 9)],
      bounded: false,
    });
    for (const drift of [-0.125, 0.125]) {
      expect(
        findUnnamedGhostClimbs(
          points,
          altitude.map((sample) => ({ ...sample, timestampMs: sample.timestampMs + drift })),
        ),
      ).toEqual({ sections: [], bounded: false });
    }
  });

  it("never starts a climb from excess sensor observations before the first GPS sample", () => {
    const { points, altitude } = climb();
    expect(
      findUnnamedGhostClimbs(points, [
        { timestampMs: -2_000, altitudeMeters: -1_000 },
        { timestampMs: -1_000, altitudeMeters: -500 },
        ...altitude,
        { timestampMs: 42_000, altitudeMeters: 1_000 },
      ]),
    ).toEqual({ sections: [bounds(points, 0, 40)], bounded: false });
  });

  it("allows a three-second altitude gap at 1 Hz and splits a four-second gap", () => {
    const { points, altitude } = climb();
    const skipMiddle = (lastSkipped: number) =>
      altitude.filter((_sample, index) => index < 19 || index > lastSkipped);
    expect(findUnnamedGhostClimbs(points, skipMiddle(20))).toEqual({
      sections: [bounds(points, 0, 40)],
      bounded: false,
    });
    expect(findUnnamedGhostClimbs(points, skipMiddle(21))).toEqual({
      sections: [],
      bounded: false,
    });
  });

  it("keeps an ascent when its five-second altitude cadence allows a seven-second interval", () => {
    const { points, altitude } = climb(81);
    const observed = altitude.filter((_sample, index) =>
      index <= 20 ? index % 5 === 0 : index >= 27 && (index - 27) % 5 === 0,
    );
    const result = findUnnamedGhostClimbs(points, observed);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.start).toEqual(bounds(points, 0, 77).start);
    expect(result.sections[0]?.end.timestampMs).toBeGreaterThan(65_000);
    expect(result.bounded).toBe(false);
  });

  it("includes the first block at the two-percent grade boundary in a sustained ascent", () => {
    const points = Array.from({ length: 5 }, (_, index) => point(index * 30, index * 2_000));
    const measured = [0, 0.6, 4.6, 8.6, 12.6];
    const altitude = points.map(({ timestampMs }, index) => ({
      timestampMs,
      altitudeMeters: measured[index] ?? null,
    }));
    expect(findUnnamedGhostClimbs(points, altitude)).toEqual({
      sections: [bounds(points, 0, 4)],
      bounded: false,
    });
  });

  it("discards a broken altitude clock and treats a nonfinite elevation as a gap", () => {
    const { points, altitude } = climb();
    expect(
      findUnnamedGhostClimbs(points, [
        { timestampMs: Number.NaN, altitudeMeters: 100 },
        ...altitude,
      ]),
    ).toEqual({ sections: [], bounded: false });
    const brokenElevation = altitude.map((sample, index) => ({
      ...sample,
      altitudeMeters: index === 20 ? Number.POSITIVE_INFINITY : sample.altitudeMeters,
    }));
    expect(findUnnamedGhostClimbs(points, brokenElevation)).toEqual({
      sections: [],
      bounded: false,
    });
  });

  it("finds a sustained ascent below sea level with exact recorded bounds", () => {
    const { points, altitude } = climb();
    const result = findUnnamedGhostClimbs(
      points,
      altitude.map((sample) => ({
        ...sample,
        altitudeMeters: sample.altitudeMeters - 200,
      })),
    );
    expect(result).toEqual({ sections: [bounds(points, 0, 40)], bounded: false });
  });

  it("brackets fractional altitude times with exact GPS observations and does not fabricate endpoints", () => {
    const { points, altitude } = climb(42);
    const offset = altitude.slice(0, -1).map((sample) => ({
      ...sample,
      timestampMs: sample.timestampMs + 0.25,
    }));
    const result = findUnnamedGhostClimbs(points, offset);
    expect(result).toEqual({ sections: [bounds(points, 0, 41)], bounded: false });
  });

  it("includes the recorded eight-second stop when both streams cover it", () => {
    const samples = Array.from({ length: 49 }, (_, index) => {
      const movingSeconds = index < 20 ? index : Math.max(20, index - 8);
      const timestampMs = index * 1_000 + 0.125;
      return {
        gps: point(movingSeconds * 4, timestampMs),
        timestampMs,
        altitudeMeters: movingSeconds * 0.4,
      };
    });
    const points = samples.map(({ gps }) => gps);
    const result = findUnnamedGhostClimbs(points, samples);
    const expected = bounds(points, 0, 48);
    expect(result).toEqual({ sections: [expected], bounded: false });
    expect(expected.end.timestampMs - expected.start.timestampMs).toBe(48_000);
  });

  it.each(["altitude dropout", "unverified source", "GPS dropout", "null GPS"] as const)(
    "does not bridge %s",
    (gap) => {
      const { points, altitude } = climb(53);
      const inputPoints =
        gap === "GPS dropout"
          ? points.filter((_point, index) => index <= 22 || index >= 30)
          : points.map((sample, index) =>
              gap === "null GPS" && index === 26 ? { ...sample, lat: null, lng: null } : sample,
            );
      const inputAltitude =
        gap === "altitude dropout"
          ? altitude.filter((_point, index) => index <= 22 || index >= 31)
          : altitude.map((sample, index) =>
              gap === "unverified source" && index === 26
                ? { ...sample, altitudeMeters: null }
                : sample,
            );
      expect(findUnnamedGhostClimbs(inputPoints, inputAltitude)).toEqual({
        sections: [],
        bounded: false,
      });
    },
  );

  it("uses valid spans on either side of a cadence barrier and keeps them distinct", () => {
    const { points, altitude } = climb(91);
    const measured = altitude.filter((_sample, index) => index <= 40 || index >= 50);
    expect(findUnnamedGhostClimbs(points, measured)).toEqual({
      sections: [bounds(points, 0, 40), bounds(points, 50, 90)],
      bounded: false,
    });
  });

  it.each([
    ["flat noise", (index: number): number => 100 + Math.sin(index) * 1.5],
    ["one positive jump", (index: number) => (index < 16 ? 100 : 132)],
    ["descent", (index: number) => 100 - index * 0.4],
    ["unverified samples", (_index: number): null => null],
    ["shallow rise", (index: number) => 100 + index * 0.09],
    ["small net rise", (index: number) => 100 + index * 0.2],
  ] as const)("rejects %s as an unnamed climb", (_label, altitudeMeters) => {
    const { points, altitude } = climb();
    expect(
      findUnnamedGhostClimbs(
        points,
        altitude.map((sample, index) => ({
          ...sample,
          altitudeMeters: altitudeMeters(index),
        })),
      ),
    ).toEqual({ sections: [], bounded: false });
  });

  it("keeps exact timestamp duplicates and splits conflicting observations", () => {
    const { points, altitude } = climb();
    const acceptDuplicate = altitude.flatMap((sample, index) =>
      index === 20 ? [sample, sample] : [sample],
    );
    expect(findUnnamedGhostClimbs(points, acceptDuplicate).sections).toEqual([
      bounds(points, 0, 40),
    ]);
    const conflict = altitude.flatMap((sample, index) =>
      index === 20 ? [sample, { ...sample, altitudeMeters: -2 }] : [sample],
    );
    expect(findUnnamedGhostClimbs(points, conflict).sections).toEqual([]);
    expect(findUnnamedGhostClimbs(points, [...altitude].reverse()).sections).toEqual([]);
  });

  it("separates sustained ascents at the first non-rising block", () => {
    const { points, altitude } = climb(89);
    const measured = altitude.map((sample, index) => ({
      ...sample,
      altitudeMeters: index <= 40 ? sample.altitudeMeters : 116 + Math.max(0, index - 48) * 0.4,
    }));
    expect(findUnnamedGhostClimbs(points, measured)).toEqual({
      sections: [bounds(points, 0, 40), bounds(points, 48, 88)],
      bounded: false,
    });
  });

  it("reports GPS, altitude and section limits without promoting incomplete climbs", () => {
    const { points, altitude } = climb(17 * 48 + 1);
    const measured = altitude.map((sample, index) => ({
      ...sample,
      altitudeMeters: 100 + Math.floor(index / 48) * 16 + Math.min(index % 48, 40) * 0.4,
    }));
    const result = findUnnamedGhostClimbs(points, measured);
    expect(result.bounded).toBe(true);
    expect(result.sections).toHaveLength(16);
    expect(result.sections.at(-1)).toEqual(bounds(points, 720, 760));
    expect(
      findUnnamedGhostClimbs(
        points,
        Array.from({ length: 20_001 }, () => ({
          timestampMs: 0,
          altitudeMeters: 100,
        })),
      ),
    ).toEqual({ sections: [], bounded: true });
    expect(
      findUnnamedGhostClimbs(
        Array.from({ length: 20_001 }, () => point(0, 0)),
        altitude,
      ),
    ).toEqual({ sections: [], bounded: true });
  });
});
