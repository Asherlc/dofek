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

describe("catalogue contracts", () => {
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
