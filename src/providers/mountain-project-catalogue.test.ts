import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { describe, expect, it, vi } from "vitest";
import { MountainProjectCatalogueAdapter } from "./mountain-project-catalogue.ts";

const seed: CatalogueSeed = {
  userId: "u",
  logEntryId: "l",
  providerId: "manual",
  externalId: null,
  sourceUrl: null,
  name: "Cragmont Crack",
  kind: "route",
  setting: "outdoor",
  locations: [],
};
const route = {
  id: "routes.105734660",
  type: "Route",
  title: "Cragmont Crack",
  url: "https://www.mountainproject.com/route/105734660/cragmont-crack",
  breadcrumbs: "California > Northeast Face",
  difficulty: { string: "5.6" },
  location: [-122.26333, 37.89205],
  tags: ["Trad", "TR"],
};
const response = (rows: unknown[], total = rows.length) =>
  Response.json({
    total: { value: total, relation: "eq" },
    hits: rows.map((row) => ({ _source: row })),
  });
describe("MountainProjectCatalogueAdapter", () => {
  it("reads exact name matches with explicit protection tags and area coordinates", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        route,
        {
          ...route,
          id: "routes.2",
          title: "Other",
          url: "https://www.mountainproject.com/route/2/other",
        },
      ]),
    );
    const result = await new MountainProjectCatalogueAdapter(fetchFn).search(seed);
    expect(result).toMatchObject({
      complete: true,
      candidates: [
        {
          providerId: "mountain-project",
          externalId: "105734660",
          name: seed.name,
          grade: "5.6",
          kind: "route",
          angle: null,
          tags: [
            { kind: "climb_type", label: "Trad" },
            { kind: "climb_type", label: "TR" },
          ],
          locations: [
            {
              name: "Northeast Face",
              scope: "area",
              coordinates: { latitude: 37.89205, longitude: -122.26333 },
            },
          ],
        },
      ],
    });
    expect(result.candidates).toHaveLength(1);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
  });
  it("paginates using observed hit counts", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([route], 2))
      .mockResolvedValueOnce(
        response(
          [{ ...route, id: "routes.2", url: "https://www.mountainproject.com/route/2/a" }],
          2,
        ),
      );
    expect(
      (await new MountainProjectCatalogueAdapter(fetchFn).search(seed)).candidates,
    ).toHaveLength(2);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("from=1");
  });
  it("stops repeated pages and caps distinct pages as incomplete", async () => {
    const repeated = vi.fn<typeof fetch>().mockImplementation(async () => response([route], 1000));
    expect((await new MountainProjectCatalogueAdapter(repeated).search(seed)).complete).toBe(false);
    expect(repeated).toHaveBeenCalledTimes(2);
    let id = 0;
    const unique = vi.fn<typeof fetch>().mockImplementation(async () =>
      response(
        [
          {
            ...route,
            id: `routes.${++id}`,
            url: `https://www.mountainproject.com/route/${id}/a`,
          },
        ],
        1000,
      ),
    );
    expect((await new MountainProjectCatalogueAdapter(unique).search(seed)).complete).toBe(false);
    expect(unique).toHaveBeenCalledTimes(3);
  });
  it("reads original-source route details without searching and scopes parent coordinates", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 105734660,
        title: "Renamed",
        parent: { id: 5, name: "Northeast Face", coordinates: [-122, 37] },
        url: route.url,
        difficulty: "5.6",
        types: ["Trad", "TR"],
      }),
    );
    const result = await new MountainProjectCatalogueAdapter(fetchFn).search({
      ...seed,
      providerId: "mountain-project",
      externalId: "105734660",
      sourceUrl: route.url,
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://www.mountainproject.com/api/v2/routes/105734660",
    );
    expect(result.candidates[0]).toMatchObject({
      name: "Renamed",
      locations: [
        {
          externalId: "5",
          name: "Northeast Face",
          scope: "area",
          coordinates: { longitude: -122, latitude: 37 },
        },
      ],
    });
  });
  it.each([
    Response.json({}),
    new Response("blocked", { status: 403 }),
    response([{ ...route, url: "https://evil.example/route/105734660" }]),
  ])("fails loudly on malformed, blocked, or foreign catalogue responses", async (value) => {
    await expect(
      new MountainProjectCatalogueAdapter(vi.fn<typeof fetch>().mockResolvedValue(value)).search(
        seed,
      ),
    ).rejects.toThrow(/Mountain Project/);
  });
  it.each([
    { externalId: "../1", sourceUrl: null },
    { externalId: "1", sourceUrl: "https://evil.example/route/1" },
  ])("validates original source before outbound requests", async (source) => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        ...source,
      }),
    ).rejects.toThrow(/Mountain Project/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports malformed JSON with source context", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
    await expect(new MountainProjectCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(
      /Mountain Project/,
    );
  });
  it("rejects an unexpected response origin", async () => {
    const value = Response.json({});
    Object.defineProperty(value, "url", { value: "https://evil.example" });
    await expect(
      new MountainProjectCatalogueAdapter(vi.fn<typeof fetch>().mockResolvedValue(value)).search(
        seed,
      ),
    ).rejects.toThrow(/unexpected redirect/);
  });

  it("rejects details whose URL identifies a different route", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 105734660,
        title: "Cragmont Crack",
        parent: { id: 5, name: "Northeast Face", coordinates: [-122, 37] },
        url: "https://www.mountainproject.com/route/999/other",
        difficulty: "5.6",
        types: ["Trad"],
      }),
    );
    await expect(
      new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        externalId: "105734660",
      }),
    ).rejects.toThrow(/identity/);
  });

  it("retains every literal public type without converting it to a technique", async () => {
    const types = ["Trad", "Sport", "TR", "Mixed", "Aid", "Alpine"];
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([{ ...route, tags: types }]));
    const result = await new MountainProjectCatalogueAdapter(fetchFn).search(seed);
    expect(result.candidates[0]?.tags).toEqual(
      types.map((label) => ({
        kind: "climb_type",
        sourceKey: "type",
        label,
        category: null,
        scope: "direct",
        inheritedFrom: null,
      })),
    );
  });

  it("sends the bounded public route search contract with encoded query text", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe(
        "https://www.mountainproject.com/api/v2/search?q=Crack%20%26%20Corner&from=0",
      );
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
      });
      expect(JSON.parse(String(init?.body))).toEqual({ types: ["Route"], filter: [], sort: [] });
      return response([]);
    });
    expect(
      await new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        name: "Crack & Corner",
      }),
    ).toEqual({ candidates: [], complete: true });
  });
  it("normalizes Unicode compatibility, surrounding whitespace, case, and repeated whitespace", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...route, title: "  ＣＲＡＧＭＯＮＴ\t  Crack  " }]));
    expect(
      (await new MountainProjectCatalogueAdapter(fetchFn).search(seed)).candidates,
    ).toHaveLength(1);
  });
  it("does not conflate distinct Unicode names by converting them to uppercase", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...route, title: "Straße Crack" }]));
    expect(
      (
        await new MountainProjectCatalogueAdapter(fetchFn).search({
          ...seed,
          name: "STRASSE CRACK",
        })
      ).candidates,
    ).toEqual([]);
  });
  it.each([null, undefined])(
    "renders a boulder without an optional grade or point (%s)",
    async (optional) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        response([
          {
            ...route,
            tags: ["Boulder"],
            difficulty: optional,
            location: optional,
            breadcrumbs: "Country > Region > Wall",
          },
        ]),
      );
      expect(
        (await new MountainProjectCatalogueAdapter(fetchFn).search(seed)).candidates[0],
      ).toMatchObject({
        kind: "boulder",
        grade: null,
        locations: [{ name: "Wall", coordinates: null }],
      });
    },
  );
  it("omits a search location when source ancestry is unavailable", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...route, breadcrumbs: "" }]));
    expect(
      (await new MountainProjectCatalogueAdapter(fetchFn).search(seed)).candidates[0]?.locations,
    ).toEqual([]);
  });
  it.each([
    "/prefix/route/105734660/x",
    "/route/105734660/x/extra",
    "/route/105734660x",
    "/route/no-id",
    "/route/105734660//",
  ])("rejects an invalid source path %s before requesting", async (path) => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        externalId: "105734660",
        sourceUrl: `https://www.mountainproject.com${path}`,
      }),
    ).rejects.toThrow(
      "Mountain Project catalogue source URL must be a Mountain Project route URL.",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    "https://user@www.mountainproject.com/route/105734660",
    "https://:password@www.mountainproject.com/route/105734660",
  ])("rejects credentials embedded in source URLs", async (sourceUrl) => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        externalId: "105734660",
        sourceUrl,
      }),
    ).rejects.toThrow(/source URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each(["105734660x", "x105734660", "", "105734660/other"])(
    "rejects malformed own-source ID %s before requesting",
    async (externalId) => {
      const fetchFn = vi.fn<typeof fetch>();
      await expect(
        new MountainProjectCatalogueAdapter(fetchFn).search({
          ...seed,
          providerId: "mountain-project",
          externalId,
        }),
      ).rejects.toThrow(/numeric/);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it("rejects mismatched source URL and ID before any remote work", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        externalId: "99",
        sourceUrl: route.url,
      }),
    ).rejects.toThrow(/disagree/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("searches when its own source lacks a native climb ID", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([route]));
    expect(
      (
        await new MountainProjectCatalogueAdapter(fetchFn).search({
          ...seed,
          providerId: "mountain-project",
        })
      ).candidates,
    ).toHaveLength(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/search?");
  });
  it("searches foreign source names without interpreting their IDs or URLs as MP identities", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([route]));
    expect(
      (
        await new MountainProjectCatalogueAdapter(fetchFn).search({
          ...seed,
          providerId: "thecrag",
          externalId: "foreign-climb",
          sourceUrl: "https://www.thecrag.com/route/55",
        })
      ).candidates,
    ).toHaveLength(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/search?");
  });
  it.each([null, undefined])(
    "returns complete original-source boulder details with optional fields %s",
    async (optional) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: 105734660,
          title: "New boulder name",
          parent: { id: 5, name: "Wall", coordinates: optional },
          url: "https://www.mountainproject.com/route/105734660",
          difficulty: optional,
          types: ["Boulder"],
        }),
      );
      const result = await new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        externalId: "105734660",
        sourceUrl: "https://www.mountainproject.com/route/105734660",
      });
      expect(result).toEqual({
        complete: true,
        candidates: [
          {
            providerId: "mountain-project",
            externalId: "105734660",
            url: "https://www.mountainproject.com/route/105734660",
            name: "New boulder name",
            kind: "boulder",
            setting: "outdoor",
            grade: null,
            angle: null,
            tags: [
              {
                kind: "climb_type",
                sourceKey: "type",
                label: "Boulder",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
            ],
            locations: [{ externalId: "5", name: "Wall", scope: "area", coordinates: null }],
          },
        ],
      });
    },
  );
  it.each([
    { id: 42 },
    { id: "105734660" },
    { parent: null },
    { difficulty: 5 },
    { types: "Trad" },
  ])("rejects malformed or mismatched native details", async (change) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 105734660,
        title: route.title,
        parent: { id: 5, name: "Wall" },
        url: route.url,
        difficulty: "5.6",
        types: ["Trad"],
        ...change,
      }),
    );
    await expect(
      new MountainProjectCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "mountain-project",
        externalId: "105734660",
      }),
    ).rejects.toThrow(/invalid route details/);
  });
  it("rejects inconsistent search-hit source identity", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...route, id: "routes.42" }]));
    await expect(new MountainProjectCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(
      /inconsistent route identity/,
    );
  });
  it("reports HTTP rejection even when the body is valid search JSON", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ total: { value: 0, relation: "eq" }, hits: [] }), {
        status: 403,
      }),
    );
    await expect(new MountainProjectCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(
      /HTTP 403/,
    );
  });
  it("retains the original malformed-JSON cause for diagnostics", async () => {
    const cause = new SyntaxError("Unexpected JSON token");
    const value = Response.json({});
    vi.spyOn(value, "json").mockRejectedValue(cause);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(value);
    await expect(new MountainProjectCatalogueAdapter(fetchFn).search(seed)).rejects.toMatchObject({
      message: "Mountain Project catalogue returned malformed JSON; retry later.",
      cause,
    });
  });
  it("accepts same-origin response URLs while rejecting redirected responses", async () => {
    const allowed = response([route]);
    Object.defineProperty(allowed, "url", {
      value: "https://www.mountainproject.com/api/v2/search",
    });
    expect(
      (
        await new MountainProjectCatalogueAdapter(
          vi.fn<typeof fetch>().mockResolvedValue(allowed),
        ).search(seed)
      ).candidates,
    ).toHaveLength(1);
    const redirected = response([route]);
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      new MountainProjectCatalogueAdapter(
        vi.fn<typeof fetch>().mockResolvedValue(redirected),
      ).search(seed),
    ).rejects.toThrow(/unexpected redirect/);
  });
  it.each([
    { value: 1, relation: "eq" },
    { value: 0, relation: "gte" },
    { value: 1, relation: "gte" },
  ])("keeps truncated empty search pages incomplete: %j", async (total) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ total, hits: [] }));
    expect(await new MountainProjectCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("does not treat lower-bound totals as a complete search", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ total: { value: 1, relation: "gte" }, hits: [{ _source: route }] }),
      )
      .mockResolvedValueOnce(Response.json({ total: { value: 1, relation: "gte" }, hits: [] }));
    const result = await new MountainProjectCatalogueAdapter(fetchFn).search(seed);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
