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
  it("hydrates the matching native ID first, reuses that lookup, and preserves local coverage", async () => {
    const events: string[] = [];
    const queries: CatalogueSeed[] = [];
    const searchArea: CatalogueSeed["locations"][number] = {
      externalId: "crag",
      name: "Local crag",
      scope: "area",
      coordinates: null,
    };
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "openbeta",
        search: async (query) => {
          events.push("openbeta");
          queries.push(query);
          return { candidates: [], complete: false, searchArea };
        },
      },
      {
        providerId: "kaya",
        search: async () => {
          events.push("kaya");
          return {
            candidates: [
              native,
              {
                ...native,
                externalId: "999",
                url: "https://kaya-app.kayaclimb.com/climb/999",
                name: "Unrelated route",
              },
            ],
            complete: true,
          };
        },
      },
    ]);
    const result = await search.search({ ...seed, kind: null, setting: null });
    expect(events).toEqual(["kaya", "openbeta"]);
    expect(queries[0]).toMatchObject({ name: "Current name", kind: "route", setting: "outdoor" });
    expect(result[0]).toMatchObject({ providerId: "openbeta", searchComplete: false, searchArea });
  });

  it("keeps absent name, alias, and reference evidence empty for an unnamed native climb", async () => {
    const queries: CatalogueSeed[] = [];
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "kaya",
        search: async () => ({
          candidates: [{ ...native, name: null, aliases: undefined, references: undefined }],
          complete: true,
        }),
      },
      {
        providerId: "openbeta",
        search: async (query) => {
          queries.push(query);
          return { candidates: [], complete: false };
        },
      },
    ]);
    await search.search({ ...seed, name: null });
    expect(queries[0]).toMatchObject({ name: null, aliases: [], references: [] });
  });

  it.each(["none", "climb", "area"] as const)(
    "retains recorded area context unless native ancestry provides an area: %s",
    async (scope) => {
      const recordedLocations: CatalogueSeed["locations"] = [
        {
          externalId: "recorded-area",
          name: "Recorded crag",
          scope: "area",
          coordinates: { latitude: 37, longitude: -122 },
        },
      ];
      const nativeLocations: CatalogueSeed["locations"] =
        scope === "none"
          ? []
          : [
              {
                externalId: "native-location",
                name: "Current location",
                scope,
                coordinates: { latitude: 38, longitude: -122 },
              },
            ];
      const queries: CatalogueSeed[] = [];
      const input = { ...seed, locations: recordedLocations };
      const search = new ClimbingCatalogueSearch([
        {
          providerId: "kaya",
          search: async () => ({
            candidates: [{ ...native, locations: nativeLocations }],
            complete: true,
          }),
        },
        {
          providerId: "openbeta",
          search: async (query) => {
            queries.push(query);
            return { candidates: [], complete: false };
          },
        },
      ]);
      const result = await search.search(input);
      expect(queries[0]?.locations).toEqual(scope === "area" ? nativeLocations : recordedLocations);
      expect(input.locations).toEqual(recordedLocations);
      expect(result[0]?.matches[0]?.candidate.locations).toEqual(nativeLocations);
    },
  );

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

  it("retains original adapter failures for the caller", async () => {
    const failure = new Error("Provider unavailable");
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "kaya",
        search: async () => {
          throw failure;
        },
      },
    ]);
    await expect(search.search(seed)).rejects.toMatchObject({ errors: [failure], sources: [] });
  });

  it("keeps each provider display message on one line while retaining its diagnostic error", async () => {
    const failure = new Error("Upstream rejected\n  climb details.\nRetry later.");
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "openbeta",
        search: async () => {
          throw failure;
        },
      },
    ]);
    await expect(search.search(seed)).rejects.toMatchObject({
      message: "openbeta: Upstream rejected climb details. Retry later.",
      errors: [failure],
    });
  });

  it("preserves successful native results when discovery sources fail", async () => {
    const failure = new Error("OpenBeta API service unavailable (502). Try again later.");
    const secondFailure = new Error("theCrag rejected the request (302). Try again later.");
    const search = new ClimbingCatalogueSearch([
      { providerId: "kaya", search: async () => ({ candidates: [native], complete: true }) },
      {
        providerId: "openbeta",
        search: async () => {
          throw failure;
        },
      },
      {
        providerId: "thecrag",
        search: async () => {
          throw secondFailure;
        },
      },
    ]);
    await expect(search.search(seed)).rejects.toMatchObject({
      errors: [failure, secondFailure],
      sources: [{ providerId: "kaya", matches: [{ confidence: "source", candidate: native }] }],
      message: expect.stringContaining("openbeta"),
    });
  });

  it("continues discovery from the original seed after a single failed native lookup", async () => {
    let nativeRequests = 0;
    const discoverySeeds: CatalogueSeed[] = [];
    const failure = new Error("Kaya rejected climb details. Try again later.");
    const search = new ClimbingCatalogueSearch([
      {
        providerId: "kaya",
        search: async () => {
          nativeRequests++;
          throw failure;
        },
      },
      {
        providerId: "openbeta",
        search: async (input) => {
          discoverySeeds.push(input);
          return { candidates: [], complete: false };
        },
      },
    ]);
    await expect(search.search(seed)).rejects.toMatchObject({
      errors: [failure],
      sources: [{ providerId: "openbeta", matches: [], searchComplete: false }],
    });
    expect(nativeRequests).toBe(1);
    expect(discoverySeeds).toEqual([seed]);
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
