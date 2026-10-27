import { describe, expect, it } from "vitest";
import { catalogueCandidateSchema } from "./climbing-catalogue.ts";

describe("informational catalogue observations", () => {
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
