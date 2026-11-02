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

function directTag(
  label: string,
  kind: "other" | "hold" | "steepness" = "other",
  category: string | null = null,
) {
  return { label, kind, category, sourceKey: label, scope: "direct" as const, inheritedFrom: null };
}
function routeOnly() {
  const data = context();
  route(data).locations = [];
  route(data).angle = null;
  return data;
}
function onlyArea(data: ClimbingCatalogueContext) {
  route(data).tags = [];
  route(data).angle = null;
  const location = area(data);
  if (!location.context) throw new Error("Missing fixture context");
  location.context.tags = [{ ...directTag("Technical"), count: 9 }];
  return location;
}

describe("catalogue trait mapping and provenance", () => {
  it.each([
    ["crimp", "crimp"],
    ["crimps", "crimp"],
    ["crimpy", "crimp"],
    ["sloper", "sloper"],
    ["slopers", "sloper"],
    ["slopey", "sloper"],
    ["pinch", "pinch"],
    ["pinches", "pinch"],
    ["jug", "jug"],
    ["jugs", "jug"],
    ["juggy", "jug"],
    ["pocket", "pocket"],
    ["pockets", "pocket"],
    ["jam", "jam"],
    ["jams", "jam"],
    ["crack", "jam"],
    ["tufa", "tufa"],
    ["tufas", "tufa"],
    ["edge", "edge"],
    ["edges", "edge"],
  ])("maps literal hold %s to %s", (label, value) => {
    const data = routeOnly();
    route(data).tags = [directTag(` ${label.toUpperCase()} `, "hold")];
    expect(catalogueStrengthTraits(seed, data)).toEqual([
      {
        dimension: "hold_type",
        value,
        source: { providerId: "openbeta", name: "Corner", url: route(data).url, scope: "route" },
      },
    ]);
  });
  it.each([
    ["slab", "slab"],
    ["ramp", "slab"],
    ["ramp slab", "slab"],
    ["vertical", "vertical"],
    ["overhang", "overhang"],
    ["overhung", "overhang"],
    ["overhanging", "overhang"],
    ["roof", "roof"],
  ])("maps literal wall %s to %s", (label, value) => {
    const data = routeOnly();
    route(data).tags = [directTag(label)];
    expect(
      catalogueStrengthTraits(seed, data).map((trait) => [trait.dimension, trait.value]),
    ).toEqual([["wall_angle", value]]);
  });
  it.each([
    "technical",
    "athletic",
    "powerful",
    "cruxy",
    "sustained",
    "endurance",
    "balance",
    "dynamic",
  ])("preserves explicit style %s", (style) => {
    const data = routeOnly();
    route(data).tags = [directTag(style)];
    expect(
      catalogueStrengthTraits(seed, data).map((trait) => [trait.dimension, trait.value]),
    ).toEqual([["style", style]]);
  });
  it.each([
    {
      kind: "steepness" as const,
      category: "roof",
      label: "Unmapped provider wall",
      expected: "roof",
    },
    { kind: "steepness" as const, category: "roof", label: "Vertical", expected: "roof" },
    { kind: "steepness" as const, category: null, label: "Vertical", expected: "vertical" },
    {
      kind: "steepness" as const,
      category: "unrecognized",
      label: "Overhung",
      expected: "overhang",
    },
    { kind: "hold" as const, category: "roof", label: "Slopers", expected: "sloper" },
  ])(
    "uses a steepness category only for steepness tags: %j",
    ({ kind, category, label, expected }) => {
      const data = routeOnly();
      route(data).tags = [directTag(label, kind, category)];
      expect(catalogueStrengthTraits(seed, data).map((trait) => trait.value)).toEqual([expected]);
    },
  );
  it("ignores unmapped route and parent labels without interpreting nearby prose", () => {
    const data = context();
    route(data).angle = null;
    route(data).tags = [directTag("Sandstone")];
    const location = onlyArea(data);
    route(data).tags = [directTag("Sandstone")];
    if (!location.context) throw new Error("Missing fixture context");
    location.context.tags = [{ ...directTag("Needs a rope"), count: 17 }];
    expect(catalogueStrengthTraits(seed, data)).toEqual([]);
  });
  it.each([
    { candidateName: "Renamed climb", seedName: "Recorded climb", expected: "Renamed climb" },
    { candidateName: null, seedName: "Recorded climb", expected: "Recorded climb" },
    { candidateName: null, seedName: null, expected: "Unnamed climb" },
  ])(
    "preserves current route name and nullable fallbacks: %j",
    ({ candidateName, seedName, expected }) => {
      const data = routeOnly();
      route(data).name = candidateName;
      expect(catalogueStrengthTraits({ ...seed, name: seedName }, data)[0]?.source.name).toBe(
        expected,
      );
    },
  );
  it.each(["source", "reference", "corroborated"] as const)(
    "accepts %s route identity without requiring a specific explanation",
    (confidence) => {
      const data = routeOnly();
      const match = data.sources[0]?.matches[0];
      if (!match) throw new Error("Missing match");
      match.confidence = confidence;
      match.evidence = ["Same native identity", "Nearby known area"];
      expect(catalogueStrengthTraits(seed, data)).toHaveLength(1);
    },
  );
  it.each(["Provider geography CONFLICT", "conflicting route type"])(
    "does not promote route evidence carrying %s",
    (evidence) => {
      const data = routeOnly();
      const match = data.sources[0]?.matches[0];
      if (!match) throw new Error("Missing match");
      match.evidence = ["Same name", evidence];
      expect(catalogueStrengthTraits(seed, data)).toEqual([]);
    },
  );
  it.each([
    {
      seedKind: null,
      candidateKind: "route" as const,
      seedSetting: "outdoor" as const,
      candidateSetting: "outdoor" as const,
    },
    {
      seedKind: "route" as const,
      candidateKind: null,
      seedSetting: "outdoor" as const,
      candidateSetting: "outdoor" as const,
    },
    {
      seedKind: "route" as const,
      candidateKind: "route" as const,
      seedSetting: null,
      candidateSetting: "outdoor" as const,
    },
    {
      seedKind: "route" as const,
      candidateKind: "route" as const,
      seedSetting: "outdoor" as const,
      candidateSetting: null,
    },
  ])(
    "keeps explicitly identified route facts when one classification is unknown: %j",
    ({ seedKind, candidateKind, seedSetting, candidateSetting }) => {
      const data = routeOnly();
      route(data).kind = candidateKind;
      route(data).setting = candidateSetting;
      expect(
        catalogueStrengthTraits({ ...seed, kind: seedKind, setting: seedSetting }, data),
      ).toHaveLength(1);
    },
  );
  it.each(["kind", "setting"] as const)(
    "rejects a confirmed route with conflicting %s",
    (field) => {
      const data = routeOnly();
      if (field === "kind") route(data).kind = "boulder";
      else route(data).setting = "indoor";
      expect(catalogueStrengthTraits(seed, data)).toEqual([]);
    },
  );
  it("deduplicates repeated source traits while retaining distinct route and parent provenance", () => {
    const data = context();
    route(data).angle = null;
    route(data).tags = [directTag("Crimpy"), directTag("Crimps")];
    const source = data.sources[0];
    if (!source) throw new Error("Missing source");
    data.sources.push(structuredClone(source));
    const traits = catalogueStrengthTraits(seed, data);
    expect(
      traits.filter((trait) => trait.value === "crimp").map((trait) => trait.source.scope),
    ).toEqual(["route", "area"]);
    expect(traits).toHaveLength(3);
  });
  it.each(["known", "missing context", "missing parent", "null inherited name"])(
    "retains inherited tag provenance with %s",
    (variant) => {
      const data = routeOnly();
      route(data).tags = [
        {
          ...directTag("Roof", "steepness"),
          scope: "inherited",
          inheritedFrom: variant === "null inherited name" ? null : "  Quarry  ",
        },
      ];
      const parent = area(context());
      const irrelevant = {
        ...structuredClone(parent),
        name: "Different area",
        context: {
          ...structuredClone(parent.context),
          url: "https://openbeta.io/area/different",
          type: null,
          sections: [],
          tags: [],
          statistics: [],
        },
      };
      route(data).locations = [irrelevant, { ...structuredClone(parent), name: null }];
      if (variant === "known") route(data).locations.push(parent);
      if (variant === "missing context")
        route(data).locations.push({ ...parent, context: undefined });
      const inherited = catalogueStrengthTraits(seed, data).find((trait) => trait.value === "roof");
      expect(inherited).toEqual({
        dimension: "wall_angle",
        value: "roof",
        source: {
          providerId: "openbeta",
          scope: "area",
          name: variant === "null inherited name" ? "Parent area" : "  Quarry  ",
          url: variant === "known" ? "https://openbeta.io/area/area" : route(data).url,
        },
      });
    },
  );
  it("keeps an area tag explicit inherited name and provider URL", () => {
    const data = context("possible");
    const location = onlyArea(data);
    if (!location.context?.tags[0]) throw new Error("Missing tag");
    location.context.tags[0].inheritedFrom = "Broader destination";
    expect(catalogueStrengthTraits(seed, data)).toEqual([
      {
        dimension: "style",
        value: "technical",
        source: {
          providerId: "openbeta",
          name: "Broader destination",
          url: "https://openbeta.io/area/area",
          scope: "area",
        },
      },
    ]);
  });
});

describe("independent parent area identity for possible routes", () => {
  it("uses native area identity through renames and absent coordinates", () => {
    const data = context("possible");
    const location = onlyArea(data);
    location.name = "Renamed quarry";
    location.coordinates = null;
    expect(catalogueStrengthTraits(seed, data)).toHaveLength(1);
  });
  it("rejects a different native area ID even when name and coordinates agree", () => {
    const data = context("possible");
    onlyArea(data).externalId = "different-area";
    expect(catalogueStrengthTraits(seed, data)).toEqual([]);
  });
  it.each(["native ID absent", "foreign provider"])(
    "uses normalized name and nearby coordinates when %s",
    (variant) => {
      const data = context("possible");
      const location = onlyArea(data);
      location.name = "  QUARRY  ";
      if (variant === "native ID absent") location.externalId = null;
      expect(
        catalogueStrengthTraits(
          { ...seed, providerId: variant === "foreign provider" ? "kaya" : "openbeta" },
          data,
        ),
      ).toHaveLength(1);
    },
  );
  it.each([
    "no recorded area",
    "no recorded name",
    "no candidate name",
    "distant area",
    "missing area context",
  ])("does not independently identify %s", (variant) => {
    const data = context("possible");
    const location = onlyArea(data);
    const recorded = structuredClone(seed);
    recorded.providerId = "kaya";
    if (variant === "no recorded area") recorded.locations = [];
    if (variant === "no recorded name" && recorded.locations[0]) recorded.locations[0].name = null;
    if (variant === "no candidate name") location.name = null;
    if (variant === "distant area") location.coordinates = { latitude: 40, longitude: -100 };
    if (variant === "missing area context") location.context = undefined;
    expect(catalogueStrengthTraits(recorded, data)).toEqual([]);
  });
});
