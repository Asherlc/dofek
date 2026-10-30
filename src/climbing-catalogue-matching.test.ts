import type {
  CatalogueCandidate,
  CatalogueLocation,
  CatalogueSearchResult,
  CatalogueSeed,
} from "@dofek/training/climbing-catalogue";
import { describe, expect, it } from "vitest";
import {
  catalogueLocalArea,
  catalogueNameMatch,
  matchCatalogueCandidates,
  normalizeCatalogueName,
} from "./climbing-catalogue-matching.ts";

const area = (name = "Goat Rock", latitude = 37.2304): CatalogueLocation => ({
  externalId: null,
  name,
  scope: "area",
  coordinates: { latitude, longitude: -122.096 },
});
const seed: CatalogueSeed = {
  userId: "user-a",
  logEntryId: "log-a",
  providerId: "mountain-project",
  externalId: "105734732",
  sourceUrl: null,
  name: "Swiss Cheese",
  kind: "route",
  setting: "outdoor",
  locations: [area()],
};
const candidate: CatalogueCandidate = {
  providerId: "openbeta",
  externalId: "openbeta-route",
  url: "https://openbeta.io/climb/openbeta-route",
  name: "Swiss Cheese",
  kind: "route",
  setting: null,
  locations: [area("Goat Rock", 37.2306)],
  grade: "5.5",
  angle: null,
  tags: [],
};
function matches(
  candidates: CatalogueCandidate[] = [candidate],
  recorded: CatalogueSeed = seed,
  discovery: Omit<CatalogueSearchResult, "candidates"> = { complete: true },
) {
  return matchCatalogueCandidates(recorded, { candidates, ...discovery }, recorded.locations);
}

describe("catalogue name discovery", () => {
  it.each([
    [" Great Roof, The ", "the great roof"],
    ["L’Arête!", "larête"],
    ["  SWISS\t CHEESE  ", "swiss cheese"],
    ["Ａ Crack", "a crack"],
    ["Corner (Left Start)", "corner left start"],
  ])("normalizes %s without erasing qualifiers", (name, expected) => {
    expect(normalizeCatalogueName(name)).toBe(expected);
  });
  it.each([
    ["The Great Roof", { name: "Great Roof, The" }, "exact"],
    ["Corner Route", { name: "Cheddar Corner", aliases: ["Corner Route"] }, "alias"],
    ["Swiss Cheese", { name: "Swis Cheese" }, "approximate"],
    ["Corner", { name: "Corner route" }, "approximate"],
    ["Corner", { name: "Gouda Arete" }, null],
    ["Corner Left", { name: "Corner Right" }, null],
  ] as const)("classifies %s against %j as %s", (name, found, expected) => {
    expect(
      catalogueNameMatch(name, { ...found, aliases: "aliases" in found ? [...found.aliases] : [] }),
    ).toBe(expected);
  });
});

describe("evidence-based catalogue matching", () => {
  it("keeps an exact local complete match possible when its explicit native-provider ID conflicts", () => {
    const wrongReference = {
      ...candidate,
      references: [{ providerId: "mountain-project" as const, externalId: "wrong-id" }],
    };
    expect(matches([wrongReference])[0]).toMatchObject({
      confidence: "possible",
      evidence: expect.arrayContaining([
        expect.stringMatching(/conflict.*mountain-project.*105734732.*wrong-id/i),
      ]),
    });
  });
  it("does not let a positive reference override a contradictory reference to the same native provider", () => {
    const conflicting = {
      ...candidate,
      references: [
        { providerId: "mountain-project" as const, externalId: "105734732" },
        { providerId: "mountain-project" as const, externalId: "wrong-id" },
      ],
    };
    expect(matches([conflicting])[0]).toMatchObject({
      confidence: "possible",
      evidence: expect.arrayContaining([expect.stringMatching(/conflict.*id/i)]),
    });
  });
  it("treats a different candidate ID from the native provider as conflicting identity evidence", () => {
    const otherNative = {
      ...candidate,
      providerId: "mountain-project" as const,
      externalId: "different-route",
    };
    expect(matches([otherNative])[0]).toMatchObject({
      confidence: "possible",
      evidence: expect.arrayContaining([expect.stringMatching(/conflict.*id/i)]),
    });
  });
  it("keeps native source identity after a rename and even conflicting observations", () => {
    const native = {
      ...candidate,
      providerId: "mountain-project" as const,
      externalId: seed.externalId ?? "",
      name: "Renamed",
      kind: "boulder" as const,
    };
    expect(matches([native])[0]).toMatchObject({
      confidence: "source",
      candidate: native,
      evidence: expect.arrayContaining([expect.stringMatching(/source.*id/i)]),
    });
  });
  it("accepts a renamed explicit MP reference without name or grade equality", () => {
    const linked = {
      ...candidate,
      name: "Corner Route",
      references: [{ providerId: "mountain-project" as const, externalId: "105734732" }],
      tags: [
        {
          kind: "climb_type" as const,
          sourceKey: "sport",
          label: "Sport",
          category: null,
          scope: "direct" as const,
          inheritedFrom: null,
        },
      ],
    };
    expect(matches([linked])[0]).toMatchObject({
      confidence: "reference",
      candidate: linked,
      evidence: expect.arrayContaining([expect.stringMatching(/reference/i)]),
    });
  });
  it("follows a reference carried by the seed", () => {
    expect(
      matches([{ ...candidate, name: "Renamed" }], {
        ...seed,
        references: [{ providerId: "openbeta", externalId: candidate.externalId }],
      })[0]?.confidence,
    ).toBe("reference");
  });
  it.each([
    { patch: { kind: "boulder" as const }, reason: /kind/i },
    { patch: { setting: "indoor" as const }, reason: /setting/i },
    { patch: { locations: [area("Chew Tooth", 37.24)] }, reason: /area/i },
  ])("keeps contradictory explicit references possible: $patch", ({ patch, reason }) => {
    const found = {
      ...candidate,
      ...patch,
      name: "Different name",
      references: [{ providerId: "mountain-project" as const, externalId: "105734732" }],
    };
    expect(matches([found])[0]).toMatchObject({
      confidence: "possible",
      evidence: expect.arrayContaining([expect.stringMatching(reason)]),
    });
  });
  it("does not infer a reference by matching names", () => {
    expect(
      matches([
        {
          ...candidate,
          locations: [],
          references: [{ providerId: "mountain-project", externalId: "wrong-id" }],
        },
      ])[0]?.confidence,
    ).toBe("possible");
  });
  it("corroborates presentation aliases and preserves independently attributed grade and style", () => {
    const aliased = {
      ...candidate,
      name: "Cheddar Corner",
      aliases: ["Swiss Cheese"],
      grade: "5.6",
    };
    expect(matches([aliased])[0]).toMatchObject({
      confidence: "corroborated",
      candidate: aliased,
      evidence: expect.arrayContaining([expect.stringMatching(/alias/i)]),
    });
  });
  it.each([
    "Swis Cheese",
    "Swiss Cheese Extension",
    "Swiss Cheese Left Start",
    "Swiss Cheese Traverse",
    "Swiss Cheese Pitch 2",
  ])("keeps approximate or qualified %s possible", (name) => {
    const result = matches([{ ...candidate, name }]);
    expect(result).toMatchObject([
      {
        confidence: "possible",
        evidence: expect.arrayContaining([expect.stringMatching(/approximate/i)]),
      },
    ]);
  });
  it("judges uniqueness within the compatible local area rather than distant or wrong-kind namesakes", () => {
    const result = matches([
      candidate,
      { ...candidate, externalId: "distant", locations: [area("Elsewhere", 40)] },
      { ...candidate, externalId: "boulder", kind: "boulder" },
    ]);
    expect(result.map((match) => match.confidence)).toEqual([
      "corroborated",
      "possible",
      "possible",
    ]);
  });
  it.each(["local", "unlocated"])(
    "keeps a match possible with a competing %s candidate",
    (competition) => {
      expect(
        matches([
          candidate,
          {
            ...candidate,
            externalId: "other",
            locations: competition === "local" ? candidate.locations : [],
          },
        ]).map((match) => match.confidence),
      ).toEqual(["possible", "possible"]);
    },
  );
  it("does not promote incomplete discovery or completeness for a different area", () => {
    expect(matches([candidate], seed, { complete: false })[0]?.confidence).toBe("possible");
    expect(
      matches([candidate], seed, { complete: true, searchArea: area("Other", 40) })[0]?.confidence,
    ).toBe("possible");
  });
  it("allows complete local-area coverage", () => {
    expect(matches([candidate], seed, { complete: true, searchArea: area() })[0]?.confidence).toBe(
      "corroborated",
    );
  });
  it("does not let shared park ancestry override conflicting nearest areas", () => {
    const park = area("Castle Rock State Park", 37.23);
    const result = matches([{ ...candidate, locations: [park, area("Chew Tooth", 37.2305)] }], {
      ...seed,
      locations: [park, area()],
    });
    expect(result[0]).toMatchObject({
      confidence: "possible",
      evidence: expect.arrayContaining([expect.stringMatching(/area/i)]),
    });
  });
  it("aligns an extra hierarchy level only when the nearer area does not contradict it", () => {
    const result = matches([{ ...candidate, locations: [area(), area("Lower Wall", 37.2306)] }]);
    expect(result[0]?.confidence).toBe("corroborated");
    expect(
      matches([{ ...candidate, locations: [area(), area("Lower Wall", 38)] }])[0]?.confidence,
    ).toBe("possible");
  });
  it.each([
    { seedSetting: null, foundSetting: "outdoor", confidence: "corroborated" },
    { seedSetting: "outdoor", foundSetting: null, confidence: "corroborated" },
    { seedSetting: null, foundSetting: null, confidence: "possible" },
    { seedSetting: "indoor", foundSetting: "indoor", confidence: "possible" },
    { seedSetting: "indoor", foundSetting: "outdoor", confidence: "possible" },
  ] as const)(
    "distinguishes unknown and contradictory settings: $seedSetting/$foundSetting",
    ({ seedSetting, foundSetting, confidence }) => {
      expect(
        matches([{ ...candidate, setting: foundSetting }], { ...seed, setting: seedSetting })[0]
          ?.confidence,
      ).toBe(confidence);
    },
  );
  it("requires known matching kinds and independent area geography", () => {
    expect(matches([{ ...candidate, kind: null }])[0]?.confidence).toBe("possible");
    expect(
      matches([{ ...candidate, locations: [area(), { ...area(), scope: "climb" }] }], {
        ...seed,
        locations: [{ ...area(), scope: "climb" }],
      })[0]?.confidence,
    ).toBe("possible");
    expect(
      matches([{ ...candidate, locations: [{ ...area(), coordinates: null }] }])[0]?.confidence,
    ).toBe("possible");
  });
  it.each([
    [0.0008, 0, "corroborated"],
    [0.0007, 0.0007, "possible"],
    [0.00091, 0, "possible"],
    [0, 0.0008, "corroborated"],
  ] as const)("uses great-circle metres for %s/%s offsets", (latitude, longitude, confidence) => {
    const origin = { ...area(), coordinates: { latitude: 0, longitude: 0 } };
    const nearby = { ...origin, coordinates: { latitude, longitude } };
    expect(
      matches([{ ...candidate, locations: [nearby] }], { ...seed, locations: [origin] })[0]
        ?.confidence,
    ).toBe(confidence);
  });
  it("does not turn duplicate source IDs or coincident climb/area points into independent evidence", () => {
    expect(matches([candidate, candidate])).toHaveLength(1);
    const unlocatedArea = { ...area(), coordinates: null };
    expect(
      matches([{ ...candidate, locations: [{ ...area(), scope: "climb" }, unlocatedArea] }])[0]
        ?.confidence,
    ).toBe("possible");
  });
});

describe("nearest local area", () => {
  it("uses the final area in ancestry and never substitutes a route coordinate", () => {
    const nearest = { ...area("Nearest"), coordinates: null };
    expect(
      catalogueLocalArea([area("World"), nearest, { ...area("Route"), scope: "climb" }]),
    ).toEqual(nearest);
    expect(catalogueLocalArea([{ ...area(), scope: "climb" }])).toBeNull();
  });
});
