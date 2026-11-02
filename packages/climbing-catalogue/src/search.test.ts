import { describe, expect, it } from "vitest";
import type { CatalogueCandidate, CatalogueSeed, ClimbingCatalogueAdapter } from "./contracts.ts";
import { ClimbingCatalogueSearch } from "./search.ts";

const seed: CatalogueSeed = {
  providerId: "kaya",
  externalId: "123",
  sourceUrl: null,
  name: "Recorded name",
  kind: "route",
  setting: "outdoor",
  locations: [],
};
const native: CatalogueCandidate = {
  providerId: "kaya",
  externalId: "123",
  url: "https://kaya-app.kayaclimb.com/climb/123",
  name: "Current name",
  aliases: ["Alias"],
  references: [{ providerId: "mountain-project", externalId: "456" }],
  kind: "route",
  setting: "outdoor",
  locations: [],
  grade: "5.10a",
  angle: null,
  tags: [],
};

describe("ClimbingCatalogueSearch", () => {
  it("enriches discovery from the native source without app IDs or mutating the input", async () => {
    const queries: CatalogueSeed[] = [];
    const original = structuredClone(seed);
    const adapters: ClimbingCatalogueAdapter[] = [
      { providerId: "kaya", search: async () => ({ candidates: [native], complete: true }) },
      {
        providerId: "mountain-project",
        search: async (query) => {
          queries.push(query);
          return {
            candidates: [
              {
                ...native,
                providerId: "mountain-project",
                externalId: "456",
                url: "https://www.mountainproject.com/route/456",
              },
            ],
            complete: false,
          };
        },
      },
    ];
    const result = await new ClimbingCatalogueSearch(adapters).search(seed);
    expect(seed).toEqual(original);
    expect(queries).toEqual([
      {
        ...seed,
        name: "Current name",
        aliases: ["Recorded name", "Alias"],
        references: native.references,
      },
    ]);
    expect(result[0]?.matches[0]).toMatchObject({ confidence: "source", candidate: native });
    expect(result[1]).toMatchObject({
      searchComplete: false,
      matches: [
        {
          confidence: "reference",
          evidence: expect.arrayContaining(["Explicit provider reference links these climbs."]),
        },
      ],
    });
  });

  it("rejects invalid seed coordinates before requesting provider data", async () => {
    let requests = 0;
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "kaya",
        search: async () => {
          requests++;
          return { candidates: [], complete: true };
        },
      },
    ]);
    await expect(
      search.search({
        ...seed,
        locations: [
          {
            externalId: null,
            name: "Area",
            scope: "area",
            coordinates: { latitude: 91, longitude: 0 },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it("propagates adapter failures to the caller", async () => {
    const failure = new Error("Provider unavailable");
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "kaya",
        search: async () => {
          throw failure;
        },
      },
    ]);
    await expect(search.search(seed)).rejects.toBe(failure);
  });

  it("rejects a candidate attributed to a different adapter", async () => {
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "openbeta",
        search: async () => ({ candidates: [native], complete: true }),
      },
    ]);
    await expect(search.search(seed)).rejects.toThrow(
      "Unexpected provider in openbeta catalogue response.",
    );
  });
});
