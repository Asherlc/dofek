import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/error-reporting.ts";
import { OpenBetaCatalogueAdapter } from "./openbeta-catalogue.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

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
function lookup(overrides = {}) {
  return new OpenBetaCatalogueAdapter(client([{ data: { climb: climb(overrides) } }])).search({
    ...seed,
    providerId: "openbeta",
    externalId: id,
  });
}

describe("OpenBetaCatalogueAdapter", () => {
  it.each(["  CRAGMONT  CRACK  ", "Ｃｒａｇｍｏｎｔ Crack", "Cragmont\t\nCrack"])(
    "finds the only exact normalized name %s",
    async (name) => {
      const fetchFn = client([
        page(1, 1, [{ document: { climbUUID: id, climbName: name } }]),
        { data: { climb: climb() } },
      ]);
      expect((await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).candidates).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["Other climb", "Cragmont", "Cragmont Crack extension"])(
    "does not fetch approximate name hit %s",
    async (name) => {
      const fetchFn = client([page(1, 1, [{ document: { climbUUID: id, climbName: name } }])]);
      expect(await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).toEqual({
        candidates: [],
        complete: true,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not merge distinct Unicode names through uppercase expansion", async () => {
    const fetchFn = client([page(1, 1, [{ document: { climbUUID: id, climbName: "STRASSE" } }])]);
    expect(await new OpenBetaCatalogueAdapter(fetchFn).search({ ...seed, name: "Straße" })).toEqual(
      { candidates: [], complete: true },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([{ lat: null, lng: 12 }, { lat: 12, lng: null }, {}, { lat: null, lng: null }])(
    "keeps incomplete coordinate pairs unknown: %o",
    async (metadata) => {
      const result = await lookup({
        metadata,
        parent: { uuid: areaId, area_name: "Northeast Face", metadata },
      });
      expect(result.candidates[0]?.locations.map((location) => location.coordinates)).toEqual([
        null,
        null,
      ]);
    },
  );

  it("ignores another provider's UUID or URL when searching OpenBeta", async () => {
    const fetchFn = client([page(0, 1, [])]);
    expect(
      await new OpenBetaCatalogueAdapter(fetchFn).search({
        ...seed,
        externalId: "other-provider-id",
        sourceUrl: "https://other.example/route/123",
      }),
    ).toEqual({ candidates: [], complete: true });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("typesense-01.openbeta.io");
  });

  it.each([
    "invalid URL",
    `https://openbeta.io/prefix/climb/${id}`,
    `https://openbeta.io/climb/${id}/slug/extra`,
    "https://openbeta.io/climb/not-a-uuid",
    `https://name@openbeta.io/climb/${id}`,
    `https://:password@openbeta.io/climb/${id}`,
    `https://openbeta.io/climb/${id}?query=1`,
    `https://openbeta.io/climb/${id}#fragment`,
  ])("rejects invalid public climb URL %s without requesting it", async (sourceUrl) => {
    const fetchFn = client([]);
    await expect(
      new OpenBetaCatalogueAdapter(fetchFn).search({ ...seed, providerId: "openbeta", sourceUrl }),
    ).rejects.toThrow(/source URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([`https://openbeta.io/climb/${id}`, `https://openbeta.io/climb/${id}/`])(
    "accepts source URLs without a name slug: %s",
    async (sourceUrl) => {
      const fetchFn = client([{ data: { climb: climb() } }]);
      expect(
        (
          await new OpenBetaCatalogueAdapter(fetchFn).search({
            ...seed,
            providerId: "openbeta",
            externalId: id,
            sourceUrl,
          })
        ).candidates[0]?.externalId,
      ).toBe(id);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects conflicts between owned UUID and source URL before requesting either", async () => {
    const fetchFn = client([]);
    await expect(
      new OpenBetaCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "openbeta",
        externalId: id,
        sourceUrl: `https://openbeta.io/climb/${areaId}`,
      }),
    ).rejects.toThrow(/identity conflicts/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retains future source flags without assigning a known climb kind", async () => {
    const result = await lookup({ type: { newDiscipline: true, trad: false } });
    expect(result.candidates[0]?.kind).toBeNull();
    expect(result.candidates[0]?.tags).toEqual([
      {
        kind: "climb_type",
        sourceKey: "newDiscipline",
        label: "newDiscipline",
        category: null,
        scope: "direct",
        inheritedFrom: null,
      },
    ]);
  });

  it("leaves mixed boulder/route classifications unknown while keeping both source tags", async () => {
    const result = await lookup({ type: { bouldering: true, sport: true } });
    expect(result.candidates[0]?.kind).toBeNull();
    expect(result.candidates[0]?.tags.map((tag) => tag.sourceKey)).toEqual(["bouldering", "sport"]);
  });

  it.each([
    { pathTokens: undefined, ancestors: undefined },
    { pathTokens: null, ancestors: null },
    { pathTokens: [], ancestors: [] },
  ])(
    "falls back to the explicitly supplied parent when ancestry is unavailable: %o",
    async (path) => {
      const result = await lookup(path);
      expect(result.candidates[0]?.locations.slice(1)).toEqual([
        {
          externalId: areaId,
          name: "Northeast Face",
          scope: "area",
          coordinates: { latitude: 37.89, longitude: -122.26 },
        },
      ]);
    },
  );

  it("preserves full area hierarchy and scopes coordinates to the nearest parent", async () => {
    const result = await lookup({ pathTokens: ["USA", "Northeast Face"], ancestors: [id, areaId] });
    expect(result.candidates[0]?.locations.slice(1)).toEqual([
      { externalId: id, name: "USA", scope: "area", coordinates: null },
      {
        externalId: areaId,
        name: "Northeast Face",
        scope: "area",
        coordinates: { latitude: 37.89, longitude: -122.26 },
      },
    ]);
  });

  it("does not invent IDs for ancestors when only their names are supplied", async () => {
    const result = await lookup({ pathTokens: ["USA", "Northeast Face"], ancestors: null });
    expect(result.candidates[0]?.locations.slice(1)).toEqual([
      { externalId: null, name: "USA", scope: "area", coordinates: null },
      {
        externalId: areaId,
        name: "Northeast Face",
        scope: "area",
        coordinates: { latitude: 37.89, longitude: -122.26 },
      },
    ]);
  });

  it.each([
    { pathTokens: ["USA", "Northeast Face"], ancestors: [areaId] },
    { pathTokens: ["Northeast Face"], ancestors: [id] },
  ])("rejects inconsistent ancestry: %o", async (path) => {
    await expect(lookup(path)).rejects.toThrow(/ancestry/);
  });

  it.each([
    [{ yds: "5.10", vscale: "V3", font: "6A" }, "V3"],
    [{ vscale: null, font: "6A" }, "6A"],
    [null, null],
  ])("uses source boulder grades without requiring route grades: %o", async (grades, expected) => {
    expect((await lookup({ type: { bouldering: true }, grades })).candidates[0]?.grade).toBe(
      expected,
    );
  });

  it.each([
    [{ french: "4c", yds: "5.6" }, "5.6"],
    [{ yds: null, font: " ", french: "4c" }, "4c"],
    [{ yds: null }, null],
    [null, null],
  ])("uses available source route grades or leaves them unknown: %o", async (grades, expected) => {
    expect((await lookup({ grades })).candidates[0]?.grade).toBe(expected);
  });

  it("rejects transport responses from a different URL", async () => {
    const response = Response.json({ data: { climb: climb() } });
    Object.defineProperty(response, "url", { value: "https://other.example/" });
    await expect(
      new OpenBetaCatalogueAdapter(vi.fn<typeof fetch>().mockResolvedValue(response)).search({
        ...seed,
        providerId: "openbeta",
        externalId: id,
      }),
    ).rejects.toThrow(/response URL/);
  });

  it("reports invalid JSON with the source error and actionable catalogue context", async () => {
    vi.mocked(captureException).mockClear();
    const parseError = new SyntaxError("invalid upstream payload");
    const response = new Response("not JSON");
    vi.spyOn(response, "json").mockRejectedValue(parseError);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(new OpenBetaCatalogueAdapter(fetchFn).search(seed)).rejects.toMatchObject({
      message: expect.stringContaining("OpenBeta catalogue returned invalid JSON"),
      cause: parseError,
    });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "openbeta", phase: "catalogue" },
    });
  });

  it.each([
    {},
    { errors: [] },
    { errors: [{ message: "upstream error" }], data: { climb: climb() } },
  ])("rejects missing data or GraphQL errors even alongside a climb: %o", async (response) => {
    await expect(
      new OpenBetaCatalogueAdapter(client([response])).search({
        ...seed,
        providerId: "openbeta",
        externalId: id,
      }),
    ).rejects.toThrow(/unavailable or invalid/);
  });

  it("sends explicit anonymous search and JSON query request metadata", async () => {
    const fetchFn = client([page(), { data: { climb: climb() } }]);
    await new OpenBetaCatalogueAdapter(fetchFn).search(seed);
    const searchUrl = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      q: seed.name,
      query_by: "climbName",
      per_page: "20",
      page: "1",
    });
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { "X-TYPESENSE-API-KEY": expect.stringMatching(/\S+/) },
    });
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
    });
  });

  it("marks repeated page responses incomplete before reading their hits", async () => {
    const fetchFn = client([page(100, 1, []), page(100, 1)]);
    expect(await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("stops at an exact full-page result-count boundary", async () => {
    const fetchFn = client([page(20, 1, [])]);
    expect(await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
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
