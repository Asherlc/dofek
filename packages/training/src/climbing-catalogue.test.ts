import { describe, expect, it } from "vitest";
import {
  catalogueCandidateSchema,
  catalogueSearchResultSchema,
  catalogueSeedSchema,
  climbingCatalogueConfidenceLabel,
  climbingCatalogueContextSchema,
  climbingCatalogueTagLabel,
} from "./climbing-catalogue.ts";

const references = [{ providerId: "mountain-project", externalId: "105736399" }];
const aliases = ["Cheddar Corner"];
const searchArea = { externalId: null, name: "Goat Rock", scope: "area", coordinates: null };
const candidate = {
  providerId: "openbeta",
  externalId: "corner",
  name: "Corner Route",
  url: "https://openbeta.io/climb/corner",
  kind: "route",
  setting: null,
  locations: [searchArea],
  grade: "5.6",
  angle: null,
  tags: [],
  references,
  aliases,
};

it("carries explicit identity evidence and local coverage through the shared response", () => {
  expect(
    catalogueSearchResultSchema.parse({ candidates: [candidate], complete: true, searchArea }),
  ).toEqual({ candidates: [candidate], complete: true, searchArea });
  expect(
    catalogueSeedSchema.parse({
      userId: "user",
      logEntryId: "log",
      providerId: "kaya",
      externalId: "id",
      sourceUrl: null,
      name: "Cheddar Corner",
      kind: "route",
      setting: "outdoor",
      locations: [],
      references,
      aliases,
    }).references,
  ).toEqual(references);
  expect(
    climbingCatalogueContextSchema.parse({
      status: "ready",
      fetchedAt: null,
      expiresAt: null,
      error: null,
      sources: [
        {
          providerId: "openbeta",
          searchComplete: true,
          searchArea,
          matches: [
            {
              confidence: "reference",
              candidate,
              evidence: ["Explicit Mountain Project reference."],
            },
          ],
        },
      ],
    }).sources[0]?.matches[0]?.evidence,
  ).toEqual(["Explicit Mountain Project reference."]);
});

it("accepts independently released response clients without the optional evidence field", () => {
  expect(
    climbingCatalogueContextSchema.safeParse({
      status: "ready",
      fetchedAt: null,
      expiresAt: null,
      error: null,
      sources: [
        {
          providerId: "openbeta",
          searchComplete: false,
          matches: [{ confidence: "possible", candidate }],
        },
      ],
    }).success,
  ).toBe(true);
});

describe("catalogue tag labels", () => {
  it.each([
    { kind: "hold", category: "Movement", expected: "Holds: Source label?!" },
    { kind: "climb_type", category: "Movement", expected: "Climb type: Source label?!" },
    { kind: "steepness", category: "Movement", expected: "Wall: Source label?!" },
    { kind: "other", category: "Movement", expected: "Movement: Source label?!" },
    { kind: "other", category: null, expected: "Tag: Source label?!" },
    { kind: "other", category: "", expected: "Tag: Source label?!" },
    { kind: "other", category: "3", expected: "Tag: Source label?!" },
    { kind: "other", category: "81", expected: "Tag: Source label?!" },
    { kind: "other", category: "Movement 2", expected: "Movement 2: Source label?!" },
    { kind: "other", category: "2 movement", expected: "2 movement: Source label?!" },
  ] as const)("labels $kind tags with category $category", ({ kind, category, expected }) => {
    expect(
      climbingCatalogueTagLabel({
        kind,
        category,
        sourceKey: "source-tag",
        label: "Source label?!",
        scope: "direct",
        inheritedFrom: null,
      }),
    ).toBe(expected);
  });

  it.each([
    { scope: "direct", inheritedFrom: "Cragmont Park", expected: "Wall: Slab" },
    {
      scope: "inherited",
      inheritedFrom: "Cragmont Park",
      expected: "Wall: Slab (inherited from Cragmont Park)",
    },
    { scope: "inherited", inheritedFrom: null, expected: "Wall: Slab (inherited)" },
    { scope: "inherited", inheritedFrom: "", expected: "Wall: Slab (inherited)" },
  ] as const)(
    "attributes $scope tags from $inheritedFrom",
    ({ scope, inheritedFrom, expected }) => {
      expect(
        climbingCatalogueTagLabel({
          kind: "steepness",
          category: null,
          sourceKey: "slab",
          label: "Slab",
          scope,
          inheritedFrom,
        }),
      ).toBe(expected);
    },
  );
});

describe("informational catalogue observations", () => {
  it("retains OpenBeta's independent sport and trad classifications as source types", () => {
    const candidate = catalogueCandidateSchema.parse({
      providerId: "openbeta",
      externalId: "test-climb",
      name: "Mixed protection",
      url: "https://openbeta.io/climb/test-climb",
      kind: "route",
      setting: "outdoor",
      locations: [],
      grade: "5.9",
      angle: null,
      tags: ["Sport", "Trad"].map((label) => ({
        label,
        sourceKey: label.toLowerCase(),
        category: label.toLowerCase(),
        kind: "climb_type",
        scope: "direct",
        inheritedFrom: null,
      })),
    });
    expect(candidate.tags.map((tag) => tag.label)).toEqual(["Sport", "Trad"]);
  });
  it("preserves multiple inherited steepness tags without converting them into degrees", () => {
    const candidate = catalogueCandidateSchema.parse({
      providerId: "thecrag",
      externalId: "18589309",
      name: "Cragmont Crack",
      url: "https://www.thecrag.com/route/18589309",
      kind: "route",
      setting: "outdoor",
      locations: [],
      grade: "5.6",
      angle: null,
      tags: ["Slab", "Overhung"].map((label) => ({
        label,
        sourceKey: label,
        category: label.toLowerCase(),
        kind: "steepness",
        scope: "inherited",
        inheritedFrom: "Cragmont Park",
      })),
    });
    expect(candidate.tags.map((tag) => tag.label)).toEqual(["Slab", "Overhung"]);
    expect(candidate.tags.every((tag) => tag.scope === "inherited")).toBe(true);
    expect(candidate.angle).toBeNull();
  });

  it("rejects source links with an unexpected origin", () => {
    expect(
      catalogueCandidateSchema.safeParse({
        providerId: "kaya",
        externalId: "1",
        name: "Test",
        url: "https://evil.example/climb/1",
        kind: "route",
        setting: "outdoor",
        locations: [],
        grade: null,
        angle: null,
        tags: [],
      }).success,
    ).toBe(false);
  });
});

it.each([
  ["source", "Own source"],
  ["reference", "Provider reference"],
  ["corroborated", "Location corroborated"],
  ["possible", "Possible match"],
] as const)("labels %s confidence for both clients", (confidence, label) => {
  expect(climbingCatalogueConfidenceLabel(confidence)).toBe(label);
});
