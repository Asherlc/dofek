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
});
