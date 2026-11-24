import { describe, expect, it } from "vitest";
import {
  ghostSessionsCompareInputSchema,
  ghostSessionsCompareResponseSchema,
  ghostSessionsGetInputSchema,
  ghostSessionsGetResponseSchema,
  ghostSessionsPassesInputSchema,
  ghostSessionsPassesResponseSchema,
  selectGhostSessionDefault,
} from "./ghost-sessions.ts";

const activityId = "30000000-0000-4000-8000-000000000000";
const olderActivityId = "10000000-0000-4000-8000-000000000000";
const newerActivityId = "20000000-0000-4000-8000-000000000000";
const sectionId = "route:section-1";
const anchor = {
  start: { timestampMs: 300_000.125, lat: 37.1, lng: -122.2, distanceMeters: 125 },
  end: { timestampMs: 330_000.625, lat: 37.102, lng: -122.2, distanceMeters: 350 },
  elapsedMs: 30_000.5,
};
const candidate = {
  start: { timestampMs: 180_000.375, lat: 37.100_001, lng: -122.2, distanceMeters: 450 },
  end: { timestampMs: 216_001.125, lat: 37.102_001, lng: -122.2, distanceMeters: 676 },
  elapsedMs: 36_000.75,
};
const comparison = {
  anchor,
  candidate,
  elapsedDifferenceMs: -6_000.25,
  timeBasis: "elapsed-including-recorded-stops",
  replay: [
    { anchor: anchor.start, candidate: candidate.start },
    {
      anchor: { timestampMs: 310_000.125, lat: 37.101, lng: -122.2, distanceMeters: 235 },
      candidate: { timestampMs: 192_000.375, lat: 37.101_001, lng: -122.2, distanceMeters: 560 },
    },
    { anchor: anchor.end, candidate: candidate.end },
  ] as const,
  replayDownsampled: true,
  metrics: {
    paceSecondsPerKm: { anchor: 133.3, candidate: 160 },
    heartRateBpm: null,
    powerWatts: null,
  },
};
const anchorBounds = {
  startTimestampMs: anchor.start.timestampMs,
  endTimestampMs: anchor.end.timestampMs,
};
const current = { ...anchorBounds, elapsedMs: 30_000.5 };
const olderBest = {
  passId: "previous-best",
  activityId: olderActivityId,
  passStartedAtMs: 120_000.25,
  anchor: anchorBounds,
  elapsedMs: 35_000.25,
};
const newerSlower = {
  passId: "newer-slower",
  activityId: newerActivityId,
  passStartedAtMs: 180_000.375,
  anchor: anchorBounds,
  elapsedMs: 36_000.75,
};
const checked = { historyCoverage: "complete", anchor: current } as const;

describe("Ghost Sessions response contracts", () => {
  it("accepts protected input shapes and bounds opaque IDs and cursors", () => {
    expect(ghostSessionsGetInputSchema.parse({ activityId })).toEqual({ activityId });
    expect(ghostSessionsPassesInputSchema.parse({ activityId, sectionId })).toEqual({
      activityId,
      sectionId,
    });
    const pageRequest = { activityId, sectionId, cursor: "eyJwYXNzSWQiOiJwYXNzLTEifQ" };
    expect(ghostSessionsPassesInputSchema.parse(pageRequest)).toEqual(pageRequest);
    const comparisonRequest = { activityId, sectionId, passId: "run:pass-1" };
    expect(ghostSessionsCompareInputSchema.parse(comparisonRequest)).toEqual(comparisonRequest);
    expect(
      ghostSessionsGetInputSchema.safeParse({ activityId: "provider-private-id" }).success,
    ).toBe(false);
    expect(
      ghostSessionsPassesInputSchema.safeParse({ ...pageRequest, cursor: "a".repeat(2_049) })
        .success,
    ).toBe(false);
    expect(
      ghostSessionsCompareInputSchema.safeParse({ ...comparisonRequest, passId: "" }).success,
    ).toBe(false);
  });

  it("validates a first visit with original geometry and no suggested pass", () => {
    const geometry = [
      [
        { lat: 37.1, lng: -122.2 },
        { lat: 37.102, lng: -122.2 },
      ],
    ];
    const section = { sectionId, anchor, geometry, firstVisit: true, suggestedGhost: null };
    const response = {
      availability: "ready",
      gpsCoverage: "complete",
      historyCoverage: "complete",
      sport: "running",
      nameStatus: "ready",
      sections: [
        { ...section, kind: "route" },
        { ...section, sectionId: "stretch-1", kind: "shared-stretch" },
        { ...section, sectionId: "climb-1", kind: "unnamed-climb" },
        {
          ...section,
          sectionId: "road-1",
          kind: "named-road",
          name: "Oak Road",
          attribution: "OpenStreetMap contributors",
        },
        { ...section, sectionId: "trail-1", kind: "named-trail", name: "Pine Trail" },
      ],
    };
    expect(ghostSessionsGetResponseSchema.parse(response)).toEqual(response);
    expect(
      ghostSessionsGetResponseSchema.safeParse({ ...response, historyCoverage: "partial" }).success,
    ).toBe(false);
  });

  it("keeps GPS, history, and naming coverage separate from availability", () => {
    const response = {
      availability: "ready",
      gpsCoverage: "partial",
      historyCoverage: "partial",
      sport: "cycling",
      nameStatus: "error",
      sections: [
        {
          sectionId,
          kind: "shared-stretch",
          anchor,
          suggestedGhost: { passId: "newer-slower", reason: "most-recent" },
        },
      ],
    };
    expect(ghostSessionsGetResponseSchema.parse(response)).toEqual(response);
    expect(
      ghostSessionsGetResponseSchema.parse({ ...response, nameStatus: "unavailable" }).nameStatus,
    ).toBe("unavailable");
    expect(
      ghostSessionsGetResponseSchema.safeParse({
        ...response,
        sections: [
          {
            ...response.sections[0],
            suggestedGhost: { passId: "newer-slower", reason: "previous-best" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ghostSessionsGetResponseSchema.parse({
        availability: "processing",
        gpsCoverage: null,
        historyCoverage: "partial",
        sport: "running",
        nameStatus: "disabled",
        sections: [],
      }).sections,
    ).toEqual([]);
  });

  it("requires a recorded anchor interval and usable GPS for a first visit", () => {
    const section = { sectionId, kind: "route", anchor, firstVisit: true, suggestedGhost: null };
    const response = {
      availability: "ready",
      gpsCoverage: "partial",
      historyCoverage: "complete",
      sport: "running",
      nameStatus: "disabled",
      sections: [section],
    };
    expect(ghostSessionsGetResponseSchema.safeParse(response).success).toBe(true);
    for (const invalid of [
      { ...response, gpsCoverage: "unusable" },
      { ...response, gpsCoverage: null },
      { ...response, sections: [{ ...section, anchor: null }] },
    ]) {
      expect(ghostSessionsGetResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires ready availability and a recorded anchor for a previous-best suggestion", () => {
    const section = {
      sectionId,
      kind: "route",
      anchor,
      suggestedGhost: { passId: "previous-best", reason: "previous-best" },
    };
    const response = {
      availability: "ready",
      gpsCoverage: "complete",
      historyCoverage: "complete",
      sport: "running",
      nameStatus: "disabled",
      sections: [section],
    };
    expect(ghostSessionsGetResponseSchema.safeParse(response).success).toBe(true);
    for (const invalid of [
      { ...response, availability: "processing" },
      { ...response, sections: [{ ...section, anchor: null }] },
      { ...response, sections: [{ ...section, anchor: { ...anchor, elapsedMs: 60_000 } }] },
    ]) {
      expect(ghostSessionsGetResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each(["unusable", null])(
    "rejects a previous-best suggestion with %s GPS coverage",
    (gpsCoverage) => {
      expect(
        ghostSessionsGetResponseSchema.safeParse({
          availability: "ready",
          gpsCoverage,
          historyCoverage: "complete",
          sport: "running",
          nameStatus: "disabled",
          sections: [
            {
              sectionId,
              kind: "route",
              anchor,
              suggestedGhost: { passId: "previous-best", reason: "previous-best" },
            },
          ],
        }).success,
      ).toBe(false);
    },
  );

  it("preserves the page order, original workout date, and measured shared elapsed times", () => {
    const response = {
      passes: [
        {
          passId: "newer-pass",
          activityId: newerActivityId,
          startedAt: "2026-11-21T17:00:00Z",
          elapsedMs: 36_000.75,
        },
        {
          passId: "older-pass",
          activityId: olderActivityId,
          startedAt: "2026-11-20T17:00:00Z",
          elapsedMs: 35_000.25,
        },
      ],
      nextCursor: "next-page-token",
    };
    expect(ghostSessionsPassesResponseSchema.parse(response)).toEqual(response);
    expect(ghostSessionsPassesResponseSchema.parse({ passes: [], nextCursor: null })).toEqual({
      passes: [],
      nextCursor: null,
    });
  });

  it("preserves signed elapsed difference, independent positions and nullable sensor channels", () => {
    expect(ghostSessionsCompareResponseSchema.parse(comparison)).toEqual(comparison);
    const noReplay = {
      ...comparison,
      replay: null,
      replayDownsampled: false,
      metrics: {
        paceSecondsPerKm: null,
        heartRateBpm: { anchor: 132, candidate: 140 },
        powerWatts: { anchor: 0, candidate: 152 },
      },
    };
    expect(ghostSessionsCompareResponseSchema.parse(noReplay)).toEqual(noReplay);
  });

  it.each([
    { anchor: { ...anchor, elapsedMs: anchor.elapsedMs + 0.002 } },
    { candidate: { ...candidate, elapsedMs: candidate.elapsedMs + 0.002 } },
    { elapsedDifferenceMs: comparison.elapsedDifferenceMs + 0.002 },
    { elapsedDifferenceMs: -comparison.elapsedDifferenceMs },
  ])("rejects inconsistent elapsed evidence %o", (change) => {
    expect(ghostSessionsCompareResponseSchema.safeParse({ ...comparison, ...change }).success).toBe(
      false,
    );
  });

  it("allows sub-microsecond arithmetic differences at fractional Unix millisecond timestamps", () => {
    const rounded = {
      ...comparison,
      anchor: {
        ...anchor,
        start: { ...anchor.start, timestampMs: 1_700_000_300_000.1 },
        end: { ...anchor.end, timestampMs: 1_700_000_330_000.2 },
        elapsedMs: 30_000.1,
      },
      elapsedDifferenceMs: -6_000.6504,
      replay: null,
      replayDownsampled: false,
    };
    expect(ghostSessionsCompareResponseSchema.parse(rounded)).toEqual(rounded);
  });

  it("allows repeated replay keys and equal progress at a recorded stop", () => {
    const [start, progress, end] = comparison.replay;
    const paused = {
      ...start,
      anchor: { ...start.anchor, timestampMs: start.anchor.timestampMs + 3_000 },
    };
    const stopped = { ...comparison, replay: [start, paused, paused, progress, end] };
    expect(ghostSessionsCompareResponseSchema.parse(stopped)).toEqual(stopped);
  });

  it("rejects replay that reverses progress on either side even when endpoints agree", () => {
    const [start, progress, end] = comparison.replay;
    for (const side of ["anchor", "candidate"] as const) {
      for (const field of ["timestampMs", "distanceMeters"] as const) {
        const reversed = {
          ...progress,
          [side]: { ...progress[side], [field]: start[side][field] - 1 },
        };
        expect(
          ghostSessionsCompareResponseSchema.safeParse({
            ...comparison,
            replay: [start, reversed, end],
          }).success,
        ).toBe(false);
      }
    }
  });

  it("rejects replay keys whose first or last positions differ from the recorded ends", () => {
    const [start, progress, end] = comparison.replay;
    const detachedStart = { ...start, anchor: { ...start.anchor, lat: 37.2 } };
    const detachedEnd = { ...end, candidate: { ...end.candidate, distanceMeters: 677 } };
    for (const replay of [
      [detachedStart, progress, end],
      [start, progress, detachedEnd],
      [end, start],
    ]) {
      expect(ghostSessionsCompareResponseSchema.safeParse({ ...comparison, replay }).success).toBe(
        false,
      );
    }
  });

  it("rejects a downsampled flag where replay is missing", () => {
    expect(
      ghostSessionsCompareResponseSchema.safeParse({ ...comparison, replay: null }).success,
    ).toBe(false);
  });

  it("rejects invalid measurement scalars, replay coordinates, and oversized replay", () => {
    expect(
      ghostSessionsCompareResponseSchema.safeParse({ ...comparison, elapsedDifferenceMs: Infinity })
        .success,
    ).toBe(false);
    expect(
      ghostSessionsCompareResponseSchema.safeParse({ ...comparison, timeBasis: "moving" }).success,
    ).toBe(false);
    expect(
      ghostSessionsCompareResponseSchema.safeParse({
        ...comparison,
        anchor: { ...anchor, elapsedMs: 0 },
      }).success,
    ).toBe(false);
    expect(
      ghostSessionsCompareResponseSchema.safeParse({
        ...comparison,
        replay: [
          { anchor: { ...anchor.start, lat: 91 }, candidate: candidate.start },
          comparison.replay[2],
        ],
      }).success,
    ).toBe(false);
    expect(
      ghostSessionsCompareResponseSchema.safeParse({
        ...comparison,
        replay: Array.from({ length: 97 }, () => comparison.replay[0]),
      }).success,
    ).toBe(false);
  });
});

describe("selectGhostSessionDefault", () => {
  it("defaults to the fastest exact prior pass when this elapsed time is a strict record", () => {
    expect(selectGhostSessionDefault({ ...checked, passes: [newerSlower, olderBest] })).toEqual({
      firstVisit: false,
      suggestedGhost: { passId: "previous-best", reason: "previous-best" },
    });
  });

  it.each([35_000.25, 35_000.5])(
    "defaults to most recent when the current %s ms does not beat the exact best",
    (elapsedMs) => {
      expect(
        selectGhostSessionDefault({
          ...checked,
          anchor: { ...current, elapsedMs },
          passes: [olderBest, newerSlower],
        }),
      ).toEqual({
        firstVisit: false,
        suggestedGhost: { passId: "newer-slower", reason: "most-recent" },
      });
    },
  );

  it("uses only exact anchor boundaries as record evidence", () => {
    const differentStart = {
      ...olderBest,
      passId: "other-start",
      anchor: { ...anchorBounds, startTimestampMs: anchorBounds.startTimestampMs - 0.125 },
      elapsedMs: 20_000,
    };
    const differentFinish = {
      ...newerSlower,
      passId: "other-finish",
      anchor: { ...anchorBounds, endTimestampMs: anchorBounds.endTimestampMs - 0.125 },
    };
    expect(
      selectGhostSessionDefault({ ...checked, passes: [differentStart, differentFinish] }),
    ).toEqual({
      firstVisit: false,
      suggestedGhost: { passId: "other-finish", reason: "most-recent" },
    });
    expect(
      selectGhostSessionDefault({
        ...checked,
        passes: [differentStart, differentFinish, olderBest],
      }),
    ).toEqual({
      firstVisit: false,
      suggestedGhost: { passId: "previous-best", reason: "previous-best" },
    });
  });

  it("defaults to latest visible in partial history even when the recorded pair is faster", () => {
    expect(
      selectGhostSessionDefault({
        ...checked,
        historyCoverage: "partial",
        passes: [olderBest, newerSlower],
      }),
    ).toEqual({
      firstVisit: false,
      suggestedGhost: { passId: "newer-slower", reason: "most-recent" },
    });
  });

  it("claims the first visit only after complete eligible history with no comparable passes", () => {
    expect(selectGhostSessionDefault({ ...checked, passes: [] })).toEqual({
      firstVisit: true,
      suggestedGhost: null,
    });
    expect(
      selectGhostSessionDefault({
        ...checked,
        historyCoverage: "partial",
        passes: [],
      }),
    ).toEqual({ firstVisit: false, suggestedGhost: null });
  });

  it("ranks prior traversals within one workout by their actual start time", () => {
    const earlier = { ...olderBest, passId: "a-earlier" };
    const later = {
      ...earlier,
      passStartedAtMs: earlier.passStartedAtMs + 0.125,
      passId: "z-later",
    };
    expect(
      selectGhostSessionDefault({
        ...checked,
        historyCoverage: "partial",
        passes: [later, earlier],
      }).suggestedGhost,
    ).toEqual({ passId: "z-later", reason: "most-recent" });
  });

  it("breaks time and elapsed ties by canonical activity ID and then pass ID", () => {
    const passOrder = [
      { ...olderBest, passId: "z-best" },
      { ...olderBest, activityId: newerActivityId, passId: "a-other-activity" },
      { ...olderBest, passId: "best-pass" },
    ];
    expect(selectGhostSessionDefault({ ...checked, passes: passOrder }).suggestedGhost).toEqual({
      passId: "best-pass",
      reason: "previous-best",
    });
    expect(
      selectGhostSessionDefault({
        ...checked,
        historyCoverage: "partial",
        passes: [...passOrder].reverse(),
      }).suggestedGhost,
    ).toEqual({ passId: "best-pass", reason: "most-recent" });
  });
});
