import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let ClimbingImportValidationError: typeof import("../../lib/climbing-import-error.ts").ClimbingImportValidationError;
let parseEightAAscentPage: typeof import("./ascent.ts").parseEightAAscentPage;
beforeEach(async () => {
  vi.resetModules();
  ({ parseEightAAscentPage } = await import("./ascent.ts"));
  ({ ClimbingImportValidationError } = await import("../../lib/climbing-import-error.ts"));
});

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
  vendorTrait: { preserved: true },
};
const page = (row: unknown) => ({ ascents: [row], totalItems: 1, pageIndex: 0 });

describe("Vertical-Life source ascents", () => {
  it("uses native occurrence identity and source dates, grades and result facts", () => {
    expect(parseEightAAscentPage(page(ascent), "bouldering", 0)).toEqual([
      {
        externalId: "eight-a:native:bouldering:eight_a:123",
        climbedOn: "2026-10-16",
        discipline: "rock_climbing",
        sourceName: "8a.nu / Vertical-Life",
        notes: "Recorded note",
        reportedGrades: [{ value: "7A", system: "font" }],
        attempts: [{ scope: "climb", sourceResult: "rp", qualifier: "free-send" }],
        climb: {
          externalId: null,
          kind: "boulder",
          setting: "outdoor",
          name: "Example boulder",
          areas: [
            { name: "France", externalId: null },
            { name: "Example Forest", externalId: null },
            { name: "Wall", externalId: null },
          ],
        },
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
        page({ ...ascent, difficulty: category === "gymroute" ? "6b" : "7A", tries: 3 }),
        category,
        0,
      );
      expect(entry?.reportedGrades).toEqual([
        { value: category === "gymroute" ? "6b" : "7A", system: null },
      ]);
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
    { ...ascent, project: "false" },
    { ...ascent, tries: -1 },
    { ...ascent, tries: 1.5 },
    { ...ascent, tries: 2_147_483_648 },
    { ...ascent, ascentId: "" },
    { ...ascent, ascentId: " " },
    { ...ascent, platform: "" },
    { ...ascent, platform: " " },
  ])("rejects malformed source facts before persistence", (row) => {
    expect(() => parseEightAAscentPage(page(row), "bouldering", 0)).toThrow(z.ZodError);
  });
  it("rejects invalid source calendar dates", () => {
    expect(() =>
      parseEightAAscentPage(page({ ...ascent, date: "2026-02-30" }), "bouldering", 0),
    ).toThrow(ClimbingImportValidationError);
  });
  it("validates the page envelope and requested position", () => {
    expect(() =>
      parseEightAAscentPage({ ascents: [], pageIndex: 1, totalItems: 0 }, "bouldering", 0),
    ).toThrow(/page/i);
    expect(() => parseEightAAscentPage({ success: false }, "bouldering", 0)).toThrow(z.ZodError);
    expect(
      parseEightAAscentPage({ ascents: [], pageIndex: 0, totalItems: 0 }, "bouldering", 0),
    ).toEqual([]);
  });
  it.each([
    ["f", { sourceResult: "f", qualifier: "free-flash" }],
    ["OS", { sourceResult: "OS", qualifier: "free-onsight" }],
    ["tr", { sourceResult: "tr", ropeMethod: "top_rope" }],
  ])("maps the native result %s without guessing another style", (type, facts) => {
    const [entry] = parseEightAAscentPage(page({ ...ascent, type }), "sportclimbing", 0);
    expect(entry?.attempts).toEqual([{ scope: "climb", ...facts }]);
  });
  it("keeps route grades French, native string IDs and positive counts", () => {
    const [entry] = parseEightAAscentPage(
      page({
        ...ascent,
        ascentId: "vl:123",
        platform: "vertical_life",
        difficulty: "6b",
        tries: 2_147_483_647,
      }),
      "sportclimbing",
      0,
    );
    expect(entry).toMatchObject({
      externalId: "eight-a:native:sportclimbing:vertical_life:vl%3A123",
      reportedGrades: [{ value: "6b", system: "french" }],
      reportedAttemptCounts: [{ scope: "climb", count: 2_147_483_647 }],
    });
  });
  it("omits unknown area labels and absent tries rather than creating empty facts", () => {
    const [entry] = parseEightAAscentPage(
      page({
        ...ascent,
        countryName: null,
        areaName: null,
        cragName: null,
        sectorName: "Unknown Sector",
        tries: null,
      }),
      "bouldering",
      0,
    );
    expect(entry?.climb).toEqual({
      externalId: null,
      name: "Example boulder",
      kind: "boulder",
      setting: "outdoor",
    });
    expect(entry?.reportedAttemptCounts).toBeUndefined();
  });
});
