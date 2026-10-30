import type { CatalogueLocation, CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/error-reporting.ts";
import { OpenBetaCatalogueAdapter } from "./openbeta-catalogue.ts";
import { goatRockArea, goatRockDiscovery } from "./openbeta-catalogue-fixture.ts";

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
function unrelatedHits(offset = 0) {
  return Array.from({ length: 20 }, (_, index) => ({
    document: {
      climbUUID: `6cc9b5d5-02d5-555a-948b-${String(offset + index).padStart(12, "0")}`,
      climbName: "Unrelated summit",
    },
  }));
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
  it("does not claim complete coverage when a fourth name remains after three empty queries", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        Response.json(
          new URL(String(input)).searchParams.get("q") === "Left start" ? page() : page(0, 1, []),
        ),
      );
    expect(
      await new OpenBetaCatalogueAdapter(fetchFn).search({
        ...seed,
        aliases: ["Up", "Down", "Left start"],
      }),
    ).toEqual({ candidates: [], complete: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])(
    "discovers historical names with request-sensitive results (overlap=%s)",
    async (overlap) => {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "api.openbeta.io")
          return Response.json({ data: { climb: climb({ name: "Up" }) } });
        const hits =
          url.searchParams.get("q") === "Up" || overlap
            ? [{ document: { climbUUID: id, climbName: "Up" } }]
            : [];
        return Response.json(page(hits.length, 1, hits));
      });
      const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
        ...seed,
        aliases: ["", "  CRAGMONT   crack ", "Up", " up "],
      });
      expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Up"]);
      expect(result.complete).toBe(true);
      expect(
        fetchFn.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q")),
      ).toEqual(["Cragmont Crack", "Up", null]);
    },
  );
  it("shares three pages across aliases before paginating and reports uncovered names", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return Response.json(page(url.searchParams.get("q") === seed.name ? 100 : 0, 1, []));
    });
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...seed,
      aliases: ["Up", "Down", "Left start"],
    });
    expect(result.complete).toBe(false);
    expect(
      fetchFn.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q")),
    ).toEqual(["Cragmont Crack", "Up", "Down"]);
  });
  it("marks missing and repeated per-query results incomplete", async () => {
    for (const repeated of [false, true]) {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "api.openbeta.io") return Response.json({ data: { climb: climb() } });
        return Response.json(
          page(21, Number(url.searchParams.get("page")), repeated ? unrelatedHits() : []),
        );
      });
      expect((await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).complete).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(repeated ? 2 : 1);
    }
  });
  it("resumes each alias at its own page while deduplicating overlapping global IDs", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.openbeta.io") return Response.json({ data: { climb: climb() } });
      const current = Number(url.searchParams.get("page"));
      return Response.json(
        url.searchParams.get("q") === seed.name
          ? page(
              21,
              current,
              current === 1
                ? unrelatedHits()
                : [{ document: { climbUUID: id, climbName: seed.name } }],
            )
          : page(),
      );
    });
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({ ...seed, aliases: ["Up"] });
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(
      fetchFn.mock.calls.map(([input]) => {
        const url = new URL(String(input));
        return [url.searchParams.get("q"), url.searchParams.get("page")];
      }),
    ).toEqual([
      ["Cragmont Crack", "1"],
      ["Up", "1"],
      ["Cragmont Crack", "2"],
      [null, null],
    ]);
  });
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

  it.each(["Other climb", "Cragmont"])("does not fetch approximate name hit %s", async (name) => {
    const fetchFn = client([page(1, 1, [{ document: { climbUUID: id, climbName: name } }])]);
    expect(await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

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
    const fetchFn = client([page(100, 1, unrelatedHits()), page(100, 1)]);
    expect(await new OpenBetaCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("stops at an exact full-page result-count boundary", async () => {
    const fetchFn = client([page(20, 1, unrelatedHits())]);
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

  it("follows full pages and retains the normalized name on the final page", async () => {
    const fetchFn = client([
      page(21, 1, unrelatedHits()),
      page(21, 2, [{ document: { climbUUID: id, climbName: " CRAGMONT  CRACK " } }]),
      { data: { climb: climb() } },
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search(seed);
    expect(result.candidates).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("marks capped and cutoff search results incomplete", async () => {
    const fetchFn = client([
      page(100, 1, unrelatedHits()),
      page(100, 2, unrelatedHits(20)),
      page(100, 3, unrelatedHits(40)),
    ]);
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

describe("OpenBeta bounded local-area discovery", () => {
  const localArea: CatalogueLocation = {
    externalId: "105734054",
    name: "Goat Rock",
    scope: "area",
    coordinates: { latitude: 37.2282, longitude: -122.1079 },
  };
  const localSeed: CatalogueSeed = {
    ...seed,
    providerId: "mountain-project",
    externalId: "105736399",
    name: "Cheddar Corner",
    kind: "route",
    setting: "outdoor",
    locations: [
      {
        externalId: "105734054",
        name: "Goat Rock",
        scope: "area",
        coordinates: { latitude: 37.2282, longitude: -122.1079 },
      },
    ],
  };
  const summary = (area: { climbs: unknown } & Record<string, unknown> = goatRockArea) => {
    const { climbs: _, ...facts } = area;
    return { data: { area: facts } };
  };
  const nearby = (areas: unknown[] = goatRockDiscovery) => ({ data: { cragsWithin: areas } });

  it("finds Corner Route independently of Cheddar Corner and retains hydrated MP references", async () => {
    const fetchFn = client([nearby(), summary(), { data: { area: goatRockArea } }]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search(localSeed);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(12);
    expect(result.searchArea).toEqual({
      externalId: "0045f7bf-6b6c-5d8a-bc9a-30f9168aea37",
      name: "Goat Rock",
      scope: "area",
      coordinates: { latitude: 37.2282, longitude: -122.1079 },
    });
    expect(result.candidates.find((candidate) => candidate.name === "Corner Route")).toMatchObject({
      externalId: "f3a2b199-c2d3-59b8-8f12-dd7ce734e88b",
      references: [{ providerId: "mountain-project", externalId: "105736399" }],
      setting: null,
      locations: expect.arrayContaining([
        {
          externalId: goatRockArea.uuid,
          name: "Goat Rock",
          scope: "area",
          coordinates: { latitude: 37.2282, longitude: -122.1079 },
        },
      ]),
    });
    const requests = fetchFn.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(requests[0].query).toContain("cragsWithin");
    expect(requests[0].variables.zoom).toBe(15);
    expect(requests[0].variables.bbox[0]).toBeCloseTo(-122.10903, 5);
    expect(requests[0].variables.bbox[1]).toBeCloseTo(37.2273, 5);
    expect(requests[0].variables.bbox[2]).toBeCloseTo(-122.10677, 5);
    expect(requests[0].variables.bbox[3]).toBeCloseTo(37.2291, 5);
    expect(requests[1].query).not.toContain("climbs {");
    expect(requests[2].variables).toEqual({ uuid: goatRockArea.uuid });
  });

  it("selects an owned area reference despite an area rename", async () => {
    const result = await new OpenBetaCatalogueAdapter(
      client([nearby(), summary(), { data: { area: goatRockArea } }]),
    ).search({
      ...localSeed,
      locations: [{ ...localArea, name: "Old Goat Rock name" }],
    });
    expect(result.candidates).toHaveLength(12);
    expect(result.complete).toBe(true);
  });

  it("uses normalized area names and distance when area IDs belong to another provider", async () => {
    const result = await new OpenBetaCatalogueAdapter(
      client([nearby(), summary(), { data: { area: goatRockArea } }]),
    ).search({
      ...localSeed,
      providerId: "kaya",
      locations: [{ ...localArea, externalId: "46774", name: "GOAT   ROCK" }],
    });
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(12);
  });

  it("does not treat a same-name area with a different owned reference as matched", async () => {
    const fetchFn = client([nearby()]);
    expect(
      await new OpenBetaCatalogueAdapter(fetchFn).search({
        ...localSeed,
        locations: [{ ...localArea, externalId: "999" }],
      }),
    ).toMatchObject({ candidates: [], complete: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...goatRockArea, uuid: areaId },
    { ...goatRockArea, metadata: { ...goatRockArea.metadata, mp_id: "999" } },
  ])("rejects mismatched hydrated area identity", async (area) => {
    await expect(
      new OpenBetaCatalogueAdapter(client([nearby(), summary(area)])).search(localSeed),
    ).rejects.toThrow(/area.*identity/i);
  });

  it("deduplicates repeated discovery areas and climbs without claiming partial counts complete", async () => {
    const area = { ...goatRockArea, climbs: [goatRockArea.climbs[0], goatRockArea.climbs[0]] };
    const fetchFn = client([nearby([goatRockArea, goatRockArea]), summary(), { data: { area } }]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search(localSeed);
    expect(result).toMatchObject({
      complete: false,
      candidates: [{ externalId: "0e68c732-da31-510e-8986-948d65689d45" }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("skips full climb hydration when metadata exceeds the 200-climb budget", async () => {
    const fetchFn = client([nearby(), summary({ ...goatRockArea, totalClimbs: 201 })]);
    expect(await new OpenBetaCatalogueAdapter(fetchFn).search(localSeed)).toMatchObject({
      candidates: [],
      complete: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("bounds matching area hydration to three areas and keeps results incomplete", async () => {
    const areas = [goatRockArea.uuid, areaId, id, "00000000-0000-4000-8000-000000000001"].map(
      (uuid) => ({
        ...goatRockArea,
        uuid,
        pathTokens: ["Goat Rock"],
        ancestors: [uuid],
        climbs: [],
        totalClimbs: 0,
      }),
    );
    const fetchFn = client([
      nearby(areas),
      ...areas.slice(0, 3).flatMap((area) => [summary(area), { data: { area } }]),
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...localSeed,
      providerId: "kaya",
    });
    expect(result).toMatchObject({ candidates: [], complete: false });
    expect(fetchFn).toHaveBeenCalledTimes(7);
  });

  it("keeps name discovery available when the nearest recorded area has unknown coordinates", async () => {
    const fetchFn = client([page(0, 1, [])]);
    expect(
      await new OpenBetaCatalogueAdapter(fetchFn).search({
        ...localSeed,
        locations: [{ ...localArea, coordinates: null }],
      }),
    ).toEqual({ candidates: [], complete: true });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("typesense");
  });

  it.each([37.22909, 37.22911, null])(
    "uses the shared 100 metre distance policy for unreferenced area point %s",
    async (lat) => {
      const area = { ...goatRockArea, metadata: { ...goatRockArea.metadata, lat } };
      const fetchFn = client([
        nearby([area]),
        ...(lat === 37.22909 ? [summary(area), { data: { area } }] : []),
      ]);
      const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
        ...localSeed,
        providerId: "kaya",
      });
      expect(result.complete).toBe(lat === 37.22909);
      expect(result.candidates).toHaveLength(lat === 37.22909 ? 12 : 0);
    },
  );

  it("uses the remaining shared climb budget before hydrating another matching area", async () => {
    const areas = [goatRockArea.uuid, areaId, id].map((uuid) => ({
      ...goatRockArea,
      uuid,
      pathTokens: ["Goat Rock"],
      ancestors: [uuid],
      totalClimbs: 80,
      climbs: Array.from({ length: 80 }, (_, i) => ({
        ...climb(),
        uuid: `00000000-0000-4000-8000-${String((uuid === id ? 160 : uuid === areaId ? 80 : 0) + i).padStart(12, "0")}`,
      })),
    }));
    const fetchFn = client([
      nearby(areas),
      ...areas.slice(0, 2).flatMap((area) => [summary(area), { data: { area } }]),
      ...areas.slice(2).map((area) => summary(area)),
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...localSeed,
      providerId: "kaya",
    });
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(160);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("counts hydrated facts against the budget even when areas repeat the same climb IDs", async () => {
    const climbs = Array.from({ length: 80 }, (_, i) => ({
      ...climb(),
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    const areas = [goatRockArea.uuid, areaId, id].map((uuid) => ({
      ...goatRockArea,
      uuid,
      pathTokens: ["Goat Rock"],
      ancestors: [uuid],
      totalClimbs: 80,
      climbs,
    }));
    const fetchFn = client([
      nearby(areas),
      ...areas.flatMap((area) => [summary(area), { data: { area } }]),
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...localSeed,
      providerId: "kaya",
    });
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(80);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });
  it("bounds duplicate-heavy full responses even when the unique count equals advertised metadata", async () => {
    const area = {
      ...goatRockArea,
      totalClimbs: 1,
      climbs: Array.from({ length: 201 }, (_, i) => ({
        ...climb(),
        name: i === 200 ? "Unprocessed overflow" : "First retained fact",
      })),
    };
    const fetchFn = client([nearby(), summary(area), { data: { area } }]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search(localSeed);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.name).toBe("First retained fact");
  });
  it("stops further area hydration when an unpaginated full response exhausts the fact budget", async () => {
    const areas = [goatRockArea.uuid, areaId].map((uuid) => ({
      ...goatRockArea,
      uuid,
      pathTokens: ["Goat Rock"],
      ancestors: [uuid],
      totalClimbs: 1,
      climbs: Array.from({ length: 201 }, () => climb()),
    }));
    const fetchFn = client([
      nearby(areas),
      ...areas.flatMap((area) => [summary(area), { data: { area } }]),
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...localSeed,
      providerId: "kaya",
    });
    expect(result.complete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

it.each(["Great Roof, The", "The Great Roofs", "The Great Roof extension"])(
  "retains presentation and approximate discovery suggestion %s with qualifiers intact",
  async (name) => {
    const fetchFn = client([
      page(1, 1, [{ document: { climbUUID: id, climbName: name } }]),
      { data: { climb: climb({ name }) } },
    ]);
    const result = await new OpenBetaCatalogueAdapter(fetchFn).search({
      ...seed,
      name: "The Great Roof",
    });
    expect(result.candidates[0]?.name).toBe(name);
  },
);

it("retains hydrated native-climb MP identity references", async () => {
  const result = await lookup({ metadata: { mp_id: "105736399" } });
  expect(result.candidates[0]?.references).toEqual([
    { providerId: "mountain-project", externalId: "105736399" },
  ]);
});
