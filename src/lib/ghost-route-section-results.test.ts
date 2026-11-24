import { describe, expect, it } from "vitest";
import {
  ghostRecordedSectionId,
  type PreparedGhostSections,
  preparedGhostSectionsSchema,
} from "./ghost-route-section-results.ts";

const anchorId = "00000000-0000-4000-8000-000000000001";
const anchorMember = "00000000-0000-4000-8000-000000000002";
const candidateId = "00000000-0000-4000-8000-000000000003";
const candidateMember = "00000000-0000-4000-8000-000000000004";
const anchorClock = Date.parse("2026-11-24T08:00:00Z") + 0.125;
const candidateClock = Date.parse("2026-11-23T08:00:00Z") + 0.375;
const emptyWindow = {
  count: 0,
  // Same uppercase SHA-256 of [] as the scalar proof query.
  digest: "4F53CDA18C2BAA0C0354BB5F9A3ECBE5ED12AB4D8E11BA873C2F11161202B945",
};

function interval(start: number, elapsedMs: number) {
  return {
    start: { timestampMs: start, lat: 0, lng: 0, distanceMeters: 30 },
    end: { timestampMs: start + elapsedMs, lat: 0, lng: 0.002, distanceMeters: 170 },
    elapsedMs,
  };
}

function fixture() {
  const anchorStamp = {
    activityId: anchorId,
    memberActivityId: anchorMember,
    providerId: "direct",
    deviceId: null,
    sport: "cycling" as const,
    modality: null,
    startedAt: "2026-11-24T07:50:00.000111Z",
    endedAt: null,
    refreshVersion: "1",
    sourceRefreshedAtNs: "20",
    memberSourceSyncedAtNs: null,
    gpsRefreshVersion: "5",
    gpsSourceRefreshedAtNs: "9",
    memberSignature: "selected",
    markerSignature: null,
  };
  const candidate = {
    ...anchorStamp,
    activityId: candidateId,
    memberActivityId: candidateMember,
    startedAt: "2026-11-23T07:53:00.000222Z",
  };
  const anchor = interval(anchorClock, 6_000);
  const pass = {
    passId: "a".repeat(64),
    activityId: candidateId,
    startedAt: candidate.startedAt,
    comparison: {
      anchor,
      candidate: interval(candidateClock, 7_000),
      elapsedDifferenceMs: -1_000,
      timeBasis: "elapsed-including-recorded-stops" as const,
      replay: null,
      replayDownsampled: false,
      metrics: {
        paceSecondsPerKm: null,
        heartRateBpm: null,
        powerWatts: { anchor: 0, candidate: 350 },
      },
    },
    scalarProof: [
      {
        activityId: anchorId,
        memberActivityId: anchorMember,
        startedAt: "2026-11-24T08:00:00.000125Z",
        endedAt: "2026-11-24T08:00:06.000125Z",
        count: 7,
        digest: "A".repeat(64),
      },
      {
        activityId: candidateId,
        memberActivityId: candidateMember,
        startedAt: "2026-11-23T08:00:00.000375Z",
        endedAt: "2026-11-23T08:00:07.000375Z",
        count: 8,
        digest: "B".repeat(64),
      },
    ],
  };
  const section = {
    sectionId: "b".repeat(64),
    kind: "unnamed-climb",
    anchor,
    historyCoverage: "partial",
    passes: [pass],
  } as const;
  const payload = {
    status: "ready",
    anchorStamp,
    candidateStamps: [candidate],
    bounded: false,
    sections: [{ ...section, passes: [pass] }],
  } satisfies PreparedGhostSections;
  return { payload, section, pass };
}

describe("preparedGhostSectionsSchema", () => {
  it("accepts records with the original candidate date and exact scoped proofs", () => {
    const { payload } = fixture();
    expect(preparedGhostSectionsSchema.parse(payload)).toEqual(payload);
  });

  it("requires anchor-first proofs scoped to the two recorded intervals when metrics exist", () => {
    const { payload, section, pass } = fixture();
    expect(
      preparedGhostSectionsSchema.safeParse({
        ...payload,
        sections: [
          { ...section, passes: [{ ...pass, scalarProof: [...pass.scalarProof].reverse() }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      preparedGhostSectionsSchema.safeParse({
        ...payload,
        sections: [{ ...section, passes: [{ ...pass, scalarProof: [] }] }],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["heartRateBpm", [true, true]],
    ["powerWatts", [true, true]],
    ["powerWatts", [true, false]],
    ["powerWatts", [false, true]],
  ] as const)("rejects measured %s with empty proof windows %j", (channel, empty) => {
    const { payload, section, pass } = fixture();
    const scalarProof = pass.scalarProof.map((proof, index) =>
      empty[index] ? { ...proof, ...emptyWindow } : proof,
    );
    const comparison = {
      ...pass.comparison,
      metrics: {
        paceSecondsPerKm: null,
        heartRateBpm: null,
        powerWatts: null,
        [channel]: { anchor: 120, candidate: 140 },
      },
    };
    expect(
      preparedGhostSectionsSchema.safeParse({
        ...payload,
        sections: [{ ...section, passes: [{ ...pass, comparison, scalarProof }] }],
      }).success,
    ).toBe(false);
  });

  it("retains exact empty-window proofs for timing-only comparisons", () => {
    const { payload, section, pass } = fixture();
    const scalarProof = pass.scalarProof.map((proof) => ({ ...proof, ...emptyWindow }));
    const comparison = {
      ...pass.comparison,
      metrics: { paceSecondsPerKm: null, heartRateBpm: null, powerWatts: null },
    };
    expect(
      preparedGhostSectionsSchema.parse({
        ...payload,
        sections: [{ ...section, passes: [{ ...pass, comparison, scalarProof }] }],
      }).sections[0]?.passes[0]?.scalarProof,
    ).toEqual(scalarProof);
  });

  it("rejects impossible clock values through safeParse", () => {
    const { payload, section, pass } = fixture();
    const anchor = interval(9_000_000_000_001_000, 6_000);
    expect(
      preparedGhostSectionsSchema.safeParse({
        ...payload,
        sections: [
          {
            ...section,
            anchor,
            passes: [
              {
                ...pass,
                comparison: { ...pass.comparison, anchor },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

it("keeps the recorded section hash stable for names-only and prepared results", () => {
  expect(ghostRecordedSectionId(anchorId, "named-road", anchorClock, anchorClock + 6_000)).toBe(
    "837b33a668884d78f67f2b7e4b688199353f7a5b8ba7900cce0267bbbb600642",
  );
});
