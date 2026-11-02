import { beforeEach, describe, expect, it, vi } from "vitest";

let contracts: typeof import("./contracts.ts");
beforeEach(async () => {
  // Schema construction is part of each test, including after another consumer reloads the module.
  vi.resetModules();
  contracts = await import("./contracts.ts");
});

const candidate = {
  providerId: "openbeta",
  externalId: "corner",
  url: "https://openbeta.io/climb/corner",
  name: "Corner Route",
  kind: "route",
  setting: "outdoor",
  locations: [],
  grade: null,
  angle: null,
  tags: [],
};
const areaContext = {
  url: "https://openbeta.io/area/area",
  type: "crag",
  sections: [
    {
      sourceKey: "description",
      label: "Description",
      text: "Sandstone above the trail.",
      inheritedFrom: "Parent park",
    },
  ],
  tags: [
    {
      sourceKey: "rock",
      label: "Sandstone",
      kind: "other",
      category: "Rock type",
      scope: "direct",
      inheritedFrom: null,
      count: null,
    },
  ],
  statistics: [{ sourceKey: "totalClimbs", label: "Climbs", value: 12 }],
};

describe("catalogue contracts", () => {
  it("preserves the complete public area context, including nullable and numeric counts", () => {
    expect(contracts.catalogueAreaContextSchema.parse(areaContext)).toEqual(areaContext);
    for (const count of [null, 0, 12]) {
      const value = {
        ...areaContext,
        type: null,
        sections: [{ ...areaContext.sections[0], inheritedFrom: null }],
        tags: [{ ...areaContext.tags[0], count }],
        statistics: [{ sourceKey: "rating", label: "Rating", value: -0.5 }],
      };
      expect(contracts.catalogueAreaContextSchema.parse(value)).toEqual(value);
    }
  });
  it("normalizes padded display text while retaining source keys", () => {
    const padded = {
      ...areaContext,
      type: "  crag  ",
      sections: [
        {
          sourceKey: "description",
          label: "  Description  ",
          text: "  Sandstone above the trail.  ",
          inheritedFrom: "  Parent park  ",
        },
      ],
      statistics: [{ sourceKey: "totalClimbs", label: "  Climbs  ", value: 12 }],
    };
    expect(contracts.catalogueAreaContextSchema.parse(padded)).toEqual(areaContext);
  });
  it.each(["", " ", "\t\n"])("rejects blank area display text: %j", (blank) => {
    const invalid = [
      { ...areaContext, type: blank },
      ...["label", "text", "inheritedFrom"].map((field) => ({
        ...areaContext,
        sections: [{ ...areaContext.sections[0], [field]: blank }],
      })),
      { ...areaContext, statistics: [{ ...areaContext.statistics[0], label: blank }] },
    ];
    for (const value of invalid)
      expect(contracts.catalogueAreaContextSchema.safeParse(value).success).toBe(false);
  });
  it("rejects missing source identifiers and incomplete nested context records", () => {
    for (const value of [
      { ...areaContext, sections: [{ ...areaContext.sections[0], sourceKey: "" }] },
      { ...areaContext, statistics: [{ ...areaContext.statistics[0], sourceKey: "" }] },
      {
        ...areaContext,
        sections: [{ sourceKey: "description", label: "Description", text: "Text" }],
      },
      {
        ...areaContext,
        tags: [
          {
            sourceKey: "rock",
            label: "Sandstone",
            kind: "other",
            category: null,
            scope: "direct",
            inheritedFrom: null,
          },
        ],
      },
      { ...areaContext, statistics: [{ sourceKey: "totalClimbs", label: "Climbs" }] },
    ])
      expect(contracts.catalogueAreaContextSchema.safeParse(value).success).toBe(false);
  });
  it("rejects unknown fields at every context level", () => {
    for (const value of [
      { ...areaContext, arbitrary: true },
      { ...areaContext, sections: [{ ...areaContext.sections[0], arbitrary: true }] },
      { ...areaContext, tags: [{ ...areaContext.tags[0], arbitrary: true }] },
      { ...areaContext, statistics: [{ ...areaContext.statistics[0], arbitrary: true }] },
    ])
      expect(contracts.catalogueAreaContextSchema.safeParse(value).success).toBe(false);
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid area tag counts: %s",
    (count) => {
      expect(
        contracts.catalogueAreaContextSchema.safeParse({
          ...areaContext,
          tags: [{ ...areaContext.tags[0], count }],
        }).success,
      ).toBe(false);
    },
  );
  it.each([Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
    "rejects non-finite area statistics: %s",
    (value) => {
      expect(
        contracts.catalogueAreaContextSchema.safeParse({
          ...areaContext,
          statistics: [{ ...areaContext.statistics[0], value }],
        }).success,
      ).toBe(false);
    },
  );
  it("explains that parent context cannot be attached to a route point", () => {
    const result = contracts.catalogueLocationSchema.safeParse({
      externalId: "route",
      name: "Route",
      scope: "climb",
      coordinates: null,
      context: areaContext,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: "Parent context belongs to an area, not a route point.",
        }),
      );
  });

  it("preserves attributed parent context separately from route tags", () => {
    const value = {
      ...candidate,
      locations: [
        {
          externalId: "area",
          name: "Crag",
          scope: "area",
          coordinates: null,
          context: areaContext,
        },
      ],
    };
    expect(contracts.catalogueCandidateSchema.parse(value)).toEqual(value);
  });
  it.each(["https://evil.example/area", "https://user@openbeta.io/area"])(
    "rejects parent context links outside source identity: %s",
    (url) => {
      expect(
        contracts.catalogueCandidateSchema.safeParse({
          ...candidate,
          locations: [
            {
              externalId: "area",
              name: "Crag",
              scope: "area",
              coordinates: null,
              context: { ...areaContext, url },
            },
          ],
        }).success,
      ).toBe(false);
    },
  );
  it("rejects area context on a route point", () => {
    expect(
      contracts.catalogueCandidateSchema.safeParse({
        ...candidate,
        locations: [
          {
            externalId: "route",
            name: "Route",
            scope: "climb",
            coordinates: null,
            context: areaContext,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects invalid source flag counts and non-finite statistics", () => {
    for (const context of [
      { ...areaContext, tags: [{ ...areaContext.tags[0], count: -1 }] },
      { ...areaContext, statistics: [{ sourceKey: "total", label: "Total", value: Number.NaN }] },
    ])
      expect(
        contracts.catalogueCandidateSchema.safeParse({
          ...candidate,
          locations: [
            { externalId: "area", name: "Crag", scope: "area", coordinates: null, context },
          ],
        }).success,
      ).toBe(false);
  });
  it("rejects matches attributed to a different source provider", () => {
    expect(
      contracts.catalogueSourceResultSchema.safeParse({
        providerId: "kaya",
        searchComplete: true,
        matches: [{ confidence: "possible", candidate }],
      }).success,
    ).toBe(false);
  });

  it("validates climb facts with nullable names and independent source references", () => {
    const seed = {
      providerId: "my-logbook",
      externalId: null,
      sourceUrl: null,
      name: null,
      kind: null,
      setting: null,
      locations: [],
      references: [{ providerId: "openbeta", externalId: "corner" }],
    };
    expect(contracts.catalogueSeedSchema.parse(seed)).toEqual(seed);
  });

  it.each([
    "https://other.example/climb/corner",
    "https://user@openbeta.io/climb/corner",
    "https://openbeta.io.evil.example/climb/corner",
  ])("rejects a candidate URL outside its source identity: %s", (url) => {
    expect(contracts.catalogueCandidateSchema.safeParse({ ...candidate, url }).success).toBe(false);
  });

  it("preserves attributed evidence and incomplete local search coverage", () => {
    const result = {
      providerId: "openbeta",
      searchComplete: false,
      searchArea: {
        externalId: "area",
        name: "Crag",
        scope: "area",
        coordinates: { latitude: 37, longitude: -122 },
      },
      matches: [{ confidence: "possible", candidate, evidence: ["Discovery is incomplete."] }],
    };
    expect(contracts.catalogueSourceResultSchema.parse(result)).toEqual(result);
  });
});
