import { describe, expect, it } from "vitest";
import { parseEightAAscentPage } from "./ascent.ts";

// Sanitized shape observed from the shared API on 2026-11-01.
const ascent = {
  ascentId: 123,
  platform: "eight_a",
  date: "2026-10-16T12:00:00+00:00",
  difficulty: "7A",
  zlaggableName: "Example boulder",
  cragName: "Example Forest",
  sectorName: "Wall",
  countryName: "France",
  areaName: null,
  type: "rp",
  repeat: false,
  project: false,
  duplicate: false,
  tries: 0,
  comment: "Recorded note",
};
const page = (row: unknown) => ({ ascents: [row], totalItems: 1, pageIndex: 0 });

describe("Vertical-Life source ascents", () => {
  it("uses native occurrence identity and source dates, grades and result facts", () => {
    expect(parseEightAAscentPage(page(ascent), "bouldering", 0)).toMatchObject([
      {
        externalId: "eight-a:native:bouldering:eight_a:123",
        climbedOn: "2026-10-16",
        reportedGrades: [{ value: "7A", system: "font" }],
        attempts: [{ scope: "climb", sourceResult: "rp", qualifier: "free-send" }],
        climb: { kind: "boulder", setting: "outdoor", name: "Example boulder" },
        raw: ascent,
      },
    ]);
  });
  it("preserves projects, repeats and duplicates without inventing attempts", () => {
    const [entry] = parseEightAAscentPage(
      page({ ...ascent, project: true, repeat: true, duplicate: true, type: null }),
      "bouldering",
      0,
    );
    expect(entry?.raw).toMatchObject({ project: true, repeat: true, duplicate: true });
    expect(entry?.reportedAttemptCounts).toBeUndefined();
    expect(entry?.attempts).toEqual([{ scope: "climb" }]);
  });
  it.each(["gymroute", "gymboulder"] as const)(
    "retains indoor grades with an unverified system for %s",
    (category) => {
      const [entry] = parseEightAAscentPage(
        page({ ...ascent, difficulty: "Purple", tries: 3 }),
        category,
        0,
      );
      expect(entry?.reportedGrades).toEqual([{ value: "Purple", system: null }]);
      expect(entry?.climb?.setting).toBe("indoor");
      expect(entry?.reportedAttemptCounts).toEqual([{ scope: "climb", count: 3 }]);
    },
  );
  it("keeps absent source facts unknown", () => {
    const [entry] = parseEightAAscentPage(
      page({
        ...ascent,
        date: null,
        difficulty: null,
        zlaggableName: null,
        comment: null,
        type: "unrecognized",
      }),
      "sportclimbing",
      0,
    );
    expect(entry).toMatchObject({
      climbedOn: null,
      reportedGrades: [],
      notes: null,
      attempts: [{ scope: "climb" }],
      climb: { name: null, kind: "route" },
    });
  });
  it("keeps native identities separate across source categories", () => {
    const [boulder] = parseEightAAscentPage(page(ascent), "bouldering", 0);
    const [route] = parseEightAAscentPage(page(ascent), "sportclimbing", 0);
    expect(boulder?.externalId).not.toBe(route?.externalId);
  });
  it.each([
    { ...ascent, ascentId: null },
    { ...ascent, date: "2026-02-30" },
    { ...ascent, project: "false" },
    { ...ascent, tries: -1 },
    { ...ascent, tries: 1.5 },
  ])("rejects malformed source facts before persistence", (row) => {
    expect(() => parseEightAAscentPage(page(row), "bouldering", 0)).toThrow();
  });
  it("validates the page envelope and requested position", () => {
    expect(() =>
      parseEightAAscentPage({ ascents: [], pageIndex: 1, totalItems: 0 }, "bouldering", 0),
    ).toThrow(/page/i);
    expect(() => parseEightAAscentPage({ success: false }, "bouldering", 0)).toThrow();
    expect(
      parseEightAAscentPage({ ascents: [], pageIndex: 0, totalItems: 0 }, "bouldering", 0),
    ).toEqual([]);
  });
});
