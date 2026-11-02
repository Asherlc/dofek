import { describe, expect, it, vi } from "vitest";
import type { CatalogueSeed } from "./contracts.ts";
import { VerticalLifeCatalogueAdapter } from "./vertical-life.ts";

const seed: CatalogueSeed = {
  providerId: "kaya",
  externalId: null,
  sourceUrl: null,
  name: "Midnight Lightning",
  kind: "boulder",
  setting: "outdoor",
  locations: [],
};
const path =
  "/crags/bouldering/united-states/camp-4/sectors/unknown-sector-5dd83/routes/midnight-lightning";
const row = {
  zlaggableName: "Midnight Lightning",
  zlaggableSlug: "midnight-lightning",
  zlaggableId: 36615,
  cragName: "Camp 4",
  cragSlug: "camp-4",
  cragId: 5766,
  countrySlug: "united-states",
  countryName: "United States of America",
  areaName: "Yosemite (CA)",
  areaSlug: "yosemite-ca",
  sectorName: "Unknown Sector",
  sectorSlug: "unknown-sector-5dd83",
  sectorId: 11438,
  type: 3,
  category: 1,
  difficulty: "7B+",
};
const native: CatalogueSeed = {
  ...seed,
  providerId: "eight-a",
  externalId: "36615",
  sourceUrl: `https://www.8a.nu${path}`,
};
function crag(overrides = {}) {
  return {
    crag: {
      unifiedId: 5766,
      cragSlug: "camp-4",
      cragName: "Camp 4",
      countrySlug: "united-states",
      areaSlug: "yosemite-ca",
      areaName: "Yosemite (CA)",
      category: 1,
      location: { latitude: 37.741609, longitude: -119.603679 },
      topFlags: [
        { name: "technical", count: 109 },
        { name: "crimpy", count: 36 },
      ],
      description: "<p>Granite <b>boulders</b></p>",
      access: "<p>Use marked trails.</p>",
      totalZlaggables: 277,
      totalAscents: 4774,
      averageRating: 3.91,
      totalSectors: 3,
      ...overrides,
    },
  };
}
function region(overrides = {}) {
  return {
    area: {
      unifiedId: 2902,
      areaSlug: "yosemite-ca",
      areaName: "Yosemite (CA)",
      countrySlug: "united-states",
      description: "<p>Valley climbing.</p>",
      totalZlaggables: 3408,
      totalRoutes: 1260,
      totalBoulders: 2148,
      totalAscents: 24265,
      averageRating: 3.89,
      ...overrides,
    },
  };
}
function client(values: unknown[], parents?: (url: URL) => unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/collection/v1/web/areas/")) {
      const areaSlug = decodeURIComponent(url.pathname.split("/areas/united-states/")[1] ?? "");
      return Response.json(parents ? parents(url) : region({ areaSlug }));
    }
    if (/\/crags\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)) {
      const category = url.pathname.includes("/sportclimbing/") ? 0 : 1;
      return Response.json(parents ? parents(url) : crag({ category }));
    }
    return Response.json(values.shift());
  });
}
function searchCalls(fetchFn: ReturnType<typeof client>) {
  return fetchFn.mock.calls.filter(([input]) =>
    new URL(String(input)).pathname.endsWith("/search"),
  );
}
function page(items: unknown[] = [row]) {
  return { items, totals: 511, totalZlaggables: 463 };
}
function detail(overrides = {}) {
  return { zlaggable: { ...row, unifiedId: 36615, zlaggableId: 6399, ...overrides } };
}

describe("VerticalLifeCatalogueAdapter", () => {
  it("hydrates attributed parent context while keeping route and sector facts separate", async () => {
    const found = await new VerticalLifeCatalogueAdapter(
      client([detail({ sectorName: "Main wall" })]),
    ).search(native);
    const candidate = found.candidates[0];
    expect(candidate?.tags).toEqual([]);
    expect(candidate?.locations[1]?.context).toMatchObject({
      url: "https://www.8a.nu/areas/united-states/yosemite-ca",
      type: null,
      sections: [
        {
          sourceKey: "description",
          label: "Description",
          text: "Valley climbing.",
          inheritedFrom: null,
        },
      ],
      statistics: expect.arrayContaining([
        { sourceKey: "totalRoutes", label: "Routes", value: 1260 },
      ]),
    });
    expect(candidate?.locations[2]).toMatchObject({
      externalId: "5766",
      coordinates: { latitude: 37.741609, longitude: -119.603679 },
      context: {
        url: "https://www.8a.nu/crags/bouldering/united-states/camp-4",
        type: null,
        sections: [
          {
            sourceKey: "description",
            label: "Description",
            text: "Granite boulders",
            inheritedFrom: null,
          },
          { sourceKey: "access", label: "Access", text: "Use marked trails.", inheritedFrom: null },
        ],
        tags: [
          {
            kind: "other",
            sourceKey: "technical",
            label: "technical",
            category: "Style",
            scope: "direct",
            inheritedFrom: null,
            count: 109,
          },
          {
            kind: "other",
            sourceKey: "crimpy",
            label: "crimpy",
            category: "Style",
            scope: "direct",
            inheritedFrom: null,
            count: 36,
          },
        ],
        statistics: expect.arrayContaining([
          { sourceKey: "averageRating", label: "Average rating", value: 3.91 },
        ]),
      },
    });
    expect(candidate?.locations.at(-1)).toEqual({
      externalId: "11438",
      name: "Main wall",
      scope: "area",
      coordinates: null,
    });
  });

  it("reuses parent reads after discovery and refreshes them for each search", async () => {
    const fetchFn = client([page([row, { ...row, zlaggableId: 2 }]), page()]);
    const adapter = new VerticalLifeCatalogueAdapter(fetchFn);
    await adapter.search(seed);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await adapter.search(seed);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("hydrates parent identities supplied by the crag when discovery omits them", async () => {
    const found = await new VerticalLifeCatalogueAdapter(
      client([page([{ ...row, areaSlug: null, areaName: null }])], (url) =>
        url.pathname.includes("/areas/") ? region() : crag({ areaName: null }),
      ),
    ).search(seed);
    expect(found.candidates[0]?.locations[1]).toMatchObject({
      externalId: "yosemite-ca",
      name: "Yosemite (CA)",
      context: { url: "https://www.8a.nu/areas/united-states/yosemite-ca" },
    });
  });

  it("keeps crags without a parent area in the correct ancestry position", async () => {
    const fetchFn = client([page([{ ...row, areaSlug: null, areaName: null }])], () =>
      crag({ areaSlug: null, areaName: null, location: null }),
    );
    const found = await new VerticalLifeCatalogueAdapter(fetchFn).search(seed);
    expect(found.candidates[0]?.locations).toHaveLength(2);
    expect(found.candidates[0]?.locations[1]).toMatchObject({
      externalId: "5766",
      context: { url: "https://www.8a.nu/crags/bouldering/united-states/camp-4" },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retains null crag coordinates", async () => {
    const found = await new VerticalLifeCatalogueAdapter(
      client([page()], (url) =>
        url.pathname.includes("/areas/") ? region() : crag({ location: null }),
      ),
    ).search(seed);
    expect(found.candidates[0]?.locations[2]?.coordinates).toBeNull();
  });

  it.each([
    { unifiedId: 99 },
    { category: 0 },
    { countrySlug: "canada" },
    { cragSlug: "another-crag" },
    { areaSlug: "another-area" },
    { topFlags: [{ name: "technical", count: -1 }] },
    { location: { latitude: 100, longitude: 0 } },
  ])("rejects mismatched or malformed crags %j", async (overrides) => {
    await expect(
      new VerticalLifeCatalogueAdapter(client([page()], () => crag(overrides))).search(seed),
    ).rejects.toThrow();
  });

  it.each([{ areaSlug: "another-area" }, { countrySlug: "canada" }, { unifiedId: null }])(
    "rejects invalid parent areas %j",
    async (overrides) => {
      await expect(
        new VerticalLifeCatalogueAdapter(
          client([page()], (url) =>
            url.pathname.includes("/areas/") ? region(overrides) : crag(),
          ),
        ).search(seed),
      ).rejects.toThrow();
    },
  );

  it("surfaces parent HTTP failures", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page()))
      .mockResolvedValue(new Response("Rejected", { status: 503 }));
    await expect(new VerticalLifeCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(
      "HTTP 503",
    );
  });

  it.each(["../secret", "scotland/../secret", "scotland//secret", "scotland/%2e%2e"])(
    "rejects unsafe area paths %s",
    async (areaSlug) => {
      await expect(
        new VerticalLifeCatalogueAdapter(client([page([{ ...row, areaSlug }])])).search(seed),
      ).rejects.toThrow();
    },
  );

  it("retains hierarchical area identifiers without treating them as route URL segments", async () => {
    const found = await new VerticalLifeCatalogueAdapter(
      client(
        [page([{ ...row, areaName: "Speyside & Moray", areaSlug: "scotland/speyside-moray" }])],
        (url) =>
          url.pathname.includes("/areas/")
            ? region({ areaSlug: "scotland/speyside-moray", areaName: "Speyside & Moray" })
            : crag({ areaSlug: "scotland/speyside-moray", areaName: "Speyside & Moray" }),
      ),
    ).search(seed);
    expect(found.candidates[0]?.locations[1]).toMatchObject({
      externalId: "scotland/speyside-moray",
      name: "Speyside & Moray",
    });
    expect(found.candidates[0]?.locations[1]?.context?.url).toBe(
      "https://www.8a.nu/areas/united-states/scotland/speyside-moray",
    );
    expect(found.candidates[0]?.url).toBe(`https://www.8a.nu${path}`);
  });
  it("accepts literal plus signs in source slugs and safely encodes native detail lookup", async () => {
    const zlaggableSlug = "midnight-lentejuelas-l1+l2";
    const found = await new VerticalLifeCatalogueAdapter(
      client([page([{ ...row, zlaggableSlug }])]),
    ).search(seed);
    expect(found.candidates[0]?.url).toContain("/routes/midnight-lentejuelas-l1%2Bl2");
    const fetchFn = client([detail({ zlaggableSlug })]);
    expect(
      (
        await new VerticalLifeCatalogueAdapter(fetchFn).search({
          ...native,
          sourceUrl: native.sourceUrl?.replace("midnight-lightning", zlaggableSlug) ?? null,
        })
      ).candidates[0]?.externalId,
    ).toBe("36615");
  });
  it("discovers attributed climbs through the public API with native IDs and ordered ancestry", async () => {
    const fetchFn = client([page()]);
    const found = await new VerticalLifeCatalogueAdapter(fetchFn).search(seed);
    expect(found).toMatchObject({
      complete: true,
      candidates: [
        {
          providerId: "eight-a",
          externalId: "36615",
          url: `https://www.8a.nu${path}`,
          name: seed.name,
          kind: "boulder",
          setting: "outdoor",
          grade: "7B+",
          angle: null,
          tags: [],
          locations: [
            {
              externalId: "united-states",
              name: "United States of America",
              scope: "area",
              coordinates: null,
            },
            { externalId: "yosemite-ca", name: "Yosemite (CA)", scope: "area", coordinates: null },
            {
              externalId: "5766",
              name: "Camp 4",
              scope: "area",
              coordinates: { latitude: 37.741609, longitude: -119.603679 },
            },
          ],
        },
      ],
    });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://vlcapi.vertical-life.info/collection/v1/web/search",
    );
    expect(url.searchParams.get("entityTypes[]")).toBe("3");
    expect(url.searchParams.get("query")).toBe(seed.name);
    expect(url.searchParams.get("pageIndex")).toBe("0");
    expect(fetchFn.mock.calls[0]?.[1]).toEqual({ redirect: "error" });
  });

  it("resolves native details by trusted route URL and uses unifiedId instead of the legacy ID", async () => {
    const fetchFn = client([detail({ zlaggableName: "Renamed", sectorName: "Boulder field" })]);
    const found = await new VerticalLifeCatalogueAdapter(fetchFn).search(native);
    expect(found.candidates[0]).toMatchObject({ externalId: "36615", name: "Renamed" });
    expect(found.candidates[0]?.locations.at(-1)).toMatchObject({
      name: "Boulder field",
      externalId: "11438",
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      `https://vlcapi.vertical-life.info/outdoor/v1/web${path}`,
    );
  });

  it.each([
    `https://evil.example${path}`,
    `https://www.8a.nu.evil.example${path}`,
    `https://user@www.8a.nu${path}`,
    "https://www.8a.nu/news/story",
    `https://www.8a.nu${path}?redirect=elsewhere`,
    "https://www.8a.nu/crags/bouldering/united-states/%2e%2e/sectors/unknown-sector-5dd83/routes/midnight-lightning",
  ])("rejects unsafe native URLs: %s", async (sourceUrl) => {
    const fetchFn = client([]);
    await expect(
      new VerticalLifeCatalogueAdapter(fetchFn).search({ ...native, sourceUrl }),
    ).rejects.toThrow(/URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects detail identity mismatches", async () => {
    await expect(
      new VerticalLifeCatalogueAdapter(client([detail({ unifiedId: 99 })])).search(native),
    ).rejects.toThrow(/ID/);
  });

  it("loads a native route URL even when its recorded ID and name are unknown", async () => {
    const found = await new VerticalLifeCatalogueAdapter(client([detail()])).search({
      ...native,
      externalId: null,
      name: null,
    });
    expect(found.candidates[0]?.externalId).toBe("36615");
  });

  it("retains an explicitly referenced Vertical-Life climb despite a changed name", async () => {
    const found = await new VerticalLifeCatalogueAdapter(
      client([page([{ ...row, zlaggableName: "Renamed completely" }])]),
    ).search({
      ...seed,
      references: [{ providerId: "eight-a", externalId: "36615" }],
    });
    expect(found.candidates[0]?.externalId).toBe("36615");
  });

  it("rejects malformed percent encoding with the actionable URL error", async () => {
    const fetchFn = client([]);
    for (const sourceUrl of [
      "https://www.8a.nu/crags/bouldering/united-states/camp-4/sectors/unknown-sector/routes/%ZZ",
      "https://www.8a.nu/crags/bouldering/united-states/camp-4/sectors/unknown-sector/routes/%FF",
    ]) {
      await expect(
        new VerticalLifeCatalogueAdapter(fetchFn).search({ ...native, sourceUrl }),
      ).rejects.toThrow("Vertical-Life catalogue source URL must be an 8a.nu route URL.");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops after three distinct full discovery pages while coverage remains incomplete", async () => {
    const pages = Array.from({ length: 4 }, (_, pageIndex) =>
      page(
        Array.from({ length: 20 }, (_, index) => ({
          ...row,
          zlaggableId: pageIndex * 20 + index + 1,
        })),
      ),
    );
    const fetchFn = client(pages);
    const found = await new VerticalLifeCatalogueAdapter(fetchFn).search(seed);
    expect(found.complete).toBe(false);
    expect(found.candidates).toHaveLength(60);
    expect(searchCalls(fetchFn)).toHaveLength(3);
    expect(
      fetchFn.mock.calls
        .slice(0, 3)
        .every(([input]) => new URL(String(input)).pathname.endsWith("/search")),
    ).toBe(true);
  });

  it("finds native IDs without a source URL through name discovery", async () => {
    const found = await new VerticalLifeCatalogueAdapter(client([page()])).search({
      ...native,
      sourceUrl: null,
    });
    expect(found.candidates[0]?.externalId).toBe("36615");
  });

  it("preserves sport routes and known sectors without inventing geometry or tags", async () => {
    const found = await new VerticalLifeCatalogueAdapter(
      client([page([{ ...row, category: 0, sectorName: "Main wall" }])]),
    ).search(seed);
    expect(found.candidates[0]).toMatchObject({
      kind: "route",
      angle: null,
      tags: [],
      setting: "outdoor",
    });
    expect(found.candidates[0]?.url).toContain("/sportclimbing/");
    expect(found.candidates[0]?.locations.at(-1)?.name).toBe("Main wall");
  });

  it("paginates within a three-request budget and deduplicates overlapping alias results", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...row, zlaggableId: i + 1 }));
    const fetchFn = client([page(rows), page([rows[0]]), page([row])]);
    const found = await new VerticalLifeCatalogueAdapter(fetchFn).search({
      ...seed,
      aliases: ["Old name"],
    });
    expect(found.complete).toBe(true);
    expect(found.candidates).toHaveLength(21);
    expect(
      searchCalls(fetchFn).map(([input]) => {
        const url = new URL(String(input));
        return [url.searchParams.get("query"), url.searchParams.get("pageIndex")];
      }),
    ).toEqual([
      [seed.name, "0"],
      ["Old name", "0"],
      [seed.name, "1"],
    ]);
  });

  it("marks exhausted and repeated discovery incomplete", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...row, zlaggableId: i + 1 }));
    expect(
      (await new VerticalLifeCatalogueAdapter(client([page(rows), page(rows)])).search(seed))
        .complete,
    ).toBe(false);
    const fetchFn = client([page([]), page([]), page([])]);
    expect(
      (
        await new VerticalLifeCatalogueAdapter(fetchFn).search({
          ...seed,
          aliases: ["Up", "Down", "Left"],
        })
      ).complete,
    ).toBe(false);
    expect(searchCalls(fetchFn)).toHaveLength(3);
  });

  it("does not query without a name or source URL", async () => {
    const fetchFn = client([]);
    expect(await new VerticalLifeCatalogueAdapter(fetchFn).search({ ...seed, name: null })).toEqual(
      { candidates: [], complete: false },
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("filters unrelated names while retaining explicit native IDs", async () => {
    const fetchFn = client([page([{ ...row, zlaggableName: "Completely different" }])]);
    expect((await new VerticalLifeCatalogueAdapter(fetchFn).search(seed)).candidates).toEqual([]);
    expect(
      (
        await new VerticalLifeCatalogueAdapter(
          client([page([{ ...row, zlaggableName: "Renamed" }])]),
        ).search({ ...native, sourceUrl: null })
      ).candidates,
    ).toHaveLength(1);
  });

  it.each([401, 403, 429, 500])("surfaces HTTP %s", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("Rejected", { status }));
    await expect(new VerticalLifeCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(
      `HTTP ${status}`,
    );
  });

  it.each([
    { items: null },
    page([{ ...row, category: 7 }]),
    page([{ ...row, zlaggableSlug: "../secret" }]),
  ])("rejects malformed source records", async (body) => {
    await expect(new VerticalLifeCatalogueAdapter(client([body])).search(seed)).rejects.toThrow();
  });

  it("rejects malformed JSON and redirects", async () => {
    await expect(
      new VerticalLifeCatalogueAdapter(
        vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>")),
      ).search(seed),
    ).rejects.toThrow(/JSON/);
    const response = Response.json(page());
    Object.defineProperty(response, "url", { value: "https://evil.example/data" });
    await expect(
      new VerticalLifeCatalogueAdapter(vi.fn<typeof fetch>().mockResolvedValue(response)).search(
        seed,
      ),
    ).rejects.toThrow(/redirect/);
  });
});
