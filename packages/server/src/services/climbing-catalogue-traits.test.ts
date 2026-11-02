import type { CatalogueSeed, ClimbingCatalogueContext } from "@dofek/training/climbing-catalogue";
import { describe, expect, it } from "vitest";
import { catalogueStrengthTraits } from "./climbing-catalogue-traits.ts";

const seed: CatalogueSeed = {
  userId: "user",
  logEntryId: "log",
  providerId: "openbeta",
  externalId: "route",
  sourceUrl: null,
  name: "Corner",
  kind: "route",
  setting: "outdoor",
  locations: [
    {
      scope: "area",
      externalId: "area",
      name: "Quarry",
      coordinates: { latitude: 37, longitude: -122 },
    },
  ],
};
function context(confidence: "source" | "possible" = "source"): ClimbingCatalogueContext {
  return {
    status: "ready",
    fetchedAt: null,
    expiresAt: null,
    error: null,
    sources: [
      {
        providerId: "openbeta",
        searchComplete: false,
        matches: [
          {
            confidence,
            candidate: {
              providerId: "openbeta",
              externalId: "route",
              url: "https://openbeta.io/climb/route",
              name: "Corner",
              kind: "route",
              setting: "outdoor",
              grade: "5.10a",
              angle: { value: 0, unit: "degrees" },
              tags: [
                {
                  kind: "hold",
                  sourceKey: "slopers",
                  label: "Slopers",
                  category: null,
                  scope: "direct",
                  inheritedFrom: null,
                },
              ],
              locations: [
                {
                  scope: "area",
                  externalId: "area",
                  name: "Quarry",
                  coordinates: { latitude: 37, longitude: -122 },
                  context: {
                    url: "https://openbeta.io/area/area",
                    type: null,
                    sections: [
                      {
                        sourceKey: "description",
                        label: "Description",
                        text: "A steep wall with pockets",
                        inheritedFrom: null,
                      },
                    ],
                    tags: [
                      {
                        kind: "other",
                        sourceKey: "technical",
                        label: "Technical",
                        category: null,
                        scope: "direct",
                        inheritedFrom: null,
                        count: 3,
                      },
                      {
                        kind: "other",
                        sourceKey: "crimpy",
                        label: "Crimpy",
                        category: null,
                        scope: "direct",
                        inheritedFrom: null,
                        count: 2,
                      },
                    ],
                    statistics: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
function route(data: ClimbingCatalogueContext) {
  const candidate = data.sources[0]?.matches[0]?.candidate;
  if (!candidate) throw new Error("Missing fixture route");
  return candidate;
}
function area(data: ClimbingCatalogueContext) {
  const location = route(data).locations[0];
  if (!location) throw new Error("Missing fixture area");
  return location;
}
describe("catalogue training trait evidence", () => {
  it("maps identified route observations and literal parent tags without interpreting prose or counts", () => {
    const traits = catalogueStrengthTraits(seed, context());
    expect(traits).toEqual(
      expect.arrayContaining([
        {
          dimension: "wall_angle",
          value: "0°",
          source: {
            providerId: "openbeta",
            scope: "route",
            name: "Corner",
            url: "https://openbeta.io/climb/route",
          },
        },
        {
          dimension: "hold_type",
          value: "sloper",
          source: {
            providerId: "openbeta",
            scope: "route",
            name: "Corner",
            url: "https://openbeta.io/climb/route",
          },
        },
        {
          dimension: "hold_type",
          value: "crimp",
          source: {
            providerId: "openbeta",
            scope: "area",
            name: "Quarry",
            url: "https://openbeta.io/area/area",
          },
        },
        {
          dimension: "style",
          value: "technical",
          source: {
            providerId: "openbeta",
            scope: "area",
            name: "Quarry",
            url: "https://openbeta.io/area/area",
          },
        },
      ]),
    );
    expect(traits).toHaveLength(4);
  });
  it("uses independently corroborated area metadata without promoting a possible route", () => {
    const result = catalogueStrengthTraits(seed, context("possible"));
    expect(result.map((t) => [t.dimension, t.value, t.source.scope])).toEqual([
      ["style", "technical", "area"],
      ["hold_type", "crimp", "area"],
    ]);
  });
  it("keeps unlocated same-name areas and possible routes out of analysis", () => {
    const data = context("possible");
    area(data).coordinates = null;
    expect(catalogueStrengthTraits({ ...seed, providerId: "eight-a" }, data)).toEqual([]);
  });
  it("retains explicit inherited route tags as area evidence so they can be excluded", () => {
    const data = context();
    route(data).tags = [
      {
        kind: "steepness",
        sourceKey: "Overhung",
        label: "Overhung",
        category: "overhang",
        scope: "inherited",
        inheritedFrom: "Quarry",
      },
    ];
    expect(catalogueStrengthTraits(seed, data)).toContainEqual({
      dimension: "wall_angle",
      value: "overhang",
      source: {
        providerId: "openbeta",
        scope: "area",
        name: "Quarry",
        url: "https://openbeta.io/area/area",
      },
    });
  });
  it("rejects source conflicts and preserves unknown tags as context", () => {
    const data = context();
    route(data).kind = "boulder";
    expect(catalogueStrengthTraits(seed, data).every((t) => t.source.scope === "area")).toBe(true);
    area(data).name = "Distant Quarry";
    expect(catalogueStrengthTraits({ ...seed, providerId: "eight-a" }, data)).toEqual([]);
  });
});
