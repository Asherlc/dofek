import { describe, expect, it } from "vitest";
import {
  catalogueCandidateSchema,
  catalogueSeedSchema,
  catalogueSourceResultSchema,
} from "./contracts.ts";

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
    expect(catalogueCandidateSchema.parse(value)).toEqual(value);
  });
  it.each(["https://evil.example/area", "https://user@openbeta.io/area"])(
    "rejects parent context links outside source identity: %s",
    (url) => {
      expect(
        catalogueCandidateSchema.safeParse({
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
      catalogueCandidateSchema.safeParse({
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
        catalogueCandidateSchema.safeParse({
          ...candidate,
          locations: [
            { externalId: "area", name: "Crag", scope: "area", coordinates: null, context },
          ],
        }).success,
      ).toBe(false);
  });
  it("rejects matches attributed to a different source provider", () => {
    expect(
      catalogueSourceResultSchema.safeParse({
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
    expect(catalogueSeedSchema.parse(seed)).toEqual(seed);
  });

  it.each([
    "https://other.example/climb/corner",
    "https://user@openbeta.io/climb/corner",
    "https://openbeta.io.evil.example/climb/corner",
  ])("rejects a candidate URL outside its source identity: %s", (url) => {
    expect(catalogueCandidateSchema.safeParse({ ...candidate, url }).success).toBe(false);
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
    expect(catalogueSourceResultSchema.parse(result)).toEqual(result);
  });
});
