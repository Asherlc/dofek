import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { describe, expect, it, vi } from "vitest";
import { OpenBetaCatalogueAdapter } from "./openbeta-catalogue.ts";

const id = "6cc9b5d5-02d5-555a-948b-e2fffc9bd82c";
const areaId = "7120fcf9-ae19-5adc-ab0d-d04f749c2e91";
const seed: CatalogueSeed = {
  userId: "u",
  logEntryId: "e",
  providerId: "kaya",
  externalId: null,
  sourceUrl: null,
  name: "Cragmont Crack",
  kind: null,
  setting: null,
  locations: [],
};
function climb(overrides = {}) {
  return {
    uuid: id,
    name: "Cragmont Crack",
    type: { trad: true, tr: true, sport: false, bouldering: false },
    grades: { yds: "5.6", french: "4c" },
    metadata: { lat: 0, lng: 0 },
    parent: { uuid: areaId, area_name: "Northeast Face", metadata: { lat: 37.89, lng: -122.26 } },
    pathTokens: ["Northeast Face"],
    ancestors: [areaId],
    ...overrides,
  };
}
function page(
  found = 1,
  current = 1,
  hits = [{ document: { climbUUID: id, climbName: "Cragmont Crack" } }],
) {
  return { found, page: current, hits, search_cutoff: false };
}
function client(values: unknown[]) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(values.shift()));
}

describe("OpenBetaCatalogueAdapter", () => {
  it("accepts native fetch URL normalization without allowing a different response origin", async () => {
    const response = Response.json({ data: { climb: climb() } });
    Object.defineProperty(response, "url", { value: "https://api.openbeta.io/" });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(
      (
        await new OpenBetaCatalogueAdapter(fetchFn).search({
          ...seed,
          providerId: "openbeta",
          externalId: id,
        })
      ).candidates[0]?.externalId,
    ).toBe(id);
  });
  it("searches published names then fetches authoritative details and all true type flags", async () => {
    const fetchFn = client([page(), { data: { climb: climb() } }]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search(seed);
    expect(result.complete).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      externalId: id,
      url: `https://openbeta.io/climb/${id}`,
      kind: "route",
      setting: null,
      grade: "5.6",
      angle: null,
    });
    expect(result.candidates[0]?.tags).toEqual([
      {
        kind: "climb_type",
        sourceKey: "trad",
        label: "Trad",
        category: "trad",
        scope: "direct",
        inheritedFrom: null,
      },
      {
        kind: "climb_type",
        sourceKey: "tr",
        label: "Top rope",
        category: "top_rope",
        scope: "direct",
        inheritedFrom: null,
      },
    ]);
    expect(result.candidates[0]?.locations).toEqual([
      {
        externalId: id,
        name: "Cragmont Crack",
        scope: "climb",
        coordinates: { latitude: 0, longitude: 0 },
      },
      {
        externalId: areaId,
        name: "Northeast Face",
        scope: "area",
        coordinates: { latitude: 37.89, longitude: -122.26 },
      },
    ]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain(
      "https://typesense-01.openbeta.io/collections/climbs/documents/search?",
    );
    expect(fetchFn.mock.calls[1]?.[0]).toBe("https://api.openbeta.io");
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("uses owned UUID independent of name changes without a tick", async () => {
    const fetchFn = client([
      { data: { climb: climb({ name: "Renamed", type: { bouldering: true } }) } },
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...seed,
      providerId: "openbeta",
      externalId: id,
    });
    expect(result.candidates[0]).toMatchObject({ name: "Renamed", kind: "boulder" });
    expect(result.complete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).variables).toEqual({ uuid: id });
  });

  it("accepts verified same-provider source URLs", async () => {
    const result = await new OpenBetaCatalogueAdapter(
      client([{ data: { climb: climb() } }]),
    ).search({
      ...seed,
      providerId: "openbeta",
      sourceUrl: `https://openbeta.io/climb/${id}/cragmont-crack`,
    });
    expect(result.candidates[0]?.externalId).toBe(id);
  });

  it("preserves every source type and does not convert false into another type", async () => {
    const type = {
      trad: false,
      sport: true,
      bouldering: null,
      deepwatersolo: true,
      alpine: true,
      snow: true,
      ice: true,
      mixed: true,
      aid: true,
      tr: true,
    };
    const result = await new OpenBetaCatalogueAdapter(
      client([{ data: { climb: climb({ type }) } }]),
    ).search({ ...seed, providerId: "openbeta", externalId: id });
    expect(result.candidates[0]?.tags.map((tag) => tag.sourceKey)).toEqual([
      "sport",
      "deepwatersolo",
      "alpine",
      "snow",
      "ice",
      "mixed",
      "aid",
      "tr",
    ]);
  });

  it("keeps kind unknown when all type flags are false", async () => {
    const result = await new OpenBetaCatalogueAdapter(
      client([{ data: { climb: climb({ type: { trad: false, bouldering: false } }) } }]),
    ).search({ ...seed, providerId: "openbeta", externalId: id });
    expect(result.candidates[0]?.kind).toBeNull();
    expect(result.candidates[0]?.tags).toEqual([]);
  });

  it("follows bounded pages and deduplicates only exact normalized names", async () => {
    const fetchFn = client([
      page(21),
      page(21, 2, [{ document: { climbUUID: id, climbName: " CRAGMONT  CRACK " } }]),
      { data: { climb: climb() } },
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search(seed);
    expect(result.candidates).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("marks capped and cutoff search results incomplete", async () => {
    const fetchFn = client([page(100, 1, []), page(100, 2, []), page(100, 3, [])]);
    expect((await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).complete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const cutoff = client([{ ...page(0, 1, []), search_cutoff: true }]);
    expect((await new OpenBetaCatalogueAdapter(cutoff).search(seed)).complete).toBe(false);
  });

  it.each([`https://evil.example/climb/${id}`, `https://openbeta.io@evil.example/climb/${id}`])(
    "rejects foreign source URLs",
    async (sourceUrl) => {
      const fetchFn = client([]);
      await expect(
        new OpenBetaCatalogueAdapter(fetchFn).search({
          ...seed,
          providerId: "openbeta",
          sourceUrl,
        }),
      ).rejects.toThrow(/source URL/i);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid UUIDs and mismatched response identities", async () => {
    const fetchFn = client([]);
    await expect(
      new OpenBetaCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "openbeta",
        externalId: "invalid",
      }),
    ).rejects.toThrow(/UUID/i);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(
      new OpenBetaCatalogueAdapter(client([{ data: { climb: climb({ uuid: areaId }) } }])).search({
        ...seed,
        providerId: "openbeta",
        externalId: id,
      }),
    ).rejects.toThrow(/identity/i);
  });

  it.each([
    { errors: [{ message: "upstream broke" }] },
    { data: { climb: null } },
    { data: { climb: { uuid: id } } },
  ])("rejects errors and malformed or missing details", async (response) => {
    await expect(
      new OpenBetaCatalogueAdapter(client([response])).search({
        ...seed,
        providerId: "openbeta",
        externalId: id,
      }),
    ).rejects.toThrow(/OpenBeta.*(?:unavailable|invalid|failed|missing)/i);
  });

  it("rejects malformed search responses and HTTP redirects", async () => {
    await expect(new OpenBetaCatalogueAdapter(client([{}])).search(seed)).rejects.toThrow(
      /search/i,
    );
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 302 }));
    await expect(new OpenBetaCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(/302/);
  });
});
