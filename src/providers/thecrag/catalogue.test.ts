import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { describe, expect, it, vi } from "vitest";
import { TheCragCatalogueAdapter } from "./catalogue.ts";

const origin = "https://www.thecrag.com";
const route = "/en/climbing/united-states/route/123";
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
function row(name = "Cragmont Crack", href = route) {
  return `<tr><td class="rt_name"><span class="route"><a href="${href}" title="23 ascents - World › United States › Cragmont Park"><span class="star">★</span>${name}</a></span></td></tr>`;
}
function search(rows = row(), next = "") {
  return `<h2 id="routes">Routes</h2><table class="routetable">${rows}</table>${next ? `<div class="pagination"><li class="next"><a href="${next}">Next</a></li></div>` : ""}`;
}
function detail(
  extra = "",
  canonical = route,
  title = "5.6 Cragmont Crack, Trad climb in Cragmont Park | theCrag",
) {
  return `<link rel="canonical" href="${origin}${canonical}"><title>${title}</title><h1><span itemprop="name">Cragmont Crack</span><span class="grade">5.6</span></h1><a class="crumb__a" href="/en/climbing/area/456" data-nid="456"><span class="crumb__long">Cragmont Park</span></a>${extra}`;
}
function client(pages: string[]) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(pages.shift(), { headers: { "content-type": "text/html" } }),
    );
}

describe("TheCragCatalogueAdapter", () => {
  it("preserves every direct/inherited steepness and unknown source tag without angle guesses", async () => {
    const tags = [
      ["Ramp", "Slab"],
      ["Vertical", "Vertical"],
      ["Overhung", "Overhung"],
      ["Roof", "Roof"],
      ["Tufa", "Tufa"],
      ["Slab", "Slab"],
      ["Unknown", "Mystery"],
    ]
      .map(
        ([key, label]) =>
          `<a rel="tag" href="/en/article/tagging#${key}" title="${key === "Ramp" ? "inherited from Cragmont Park" : ""}">${label}</a>`,
      )
      .join("");
    const fetchFn = client([
      search(),
      detail(
        tags +
          `<meta property="place:location:latitude" content="37"><meta property="place:location:longitude" content="-122">`,
      ),
    ]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search(seed);
    expect(result.complete).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      externalId: "123",
      name: seed.name,
      kind: "route",
      setting: null,
      grade: "5.6",
      angle: null,
    });
    expect(
      result.candidates[0]?.tags.map((tag) => [tag.sourceKey, tag.kind, tag.category]),
    ).toEqual([
      ["Ramp", "steepness", "slab"],
      ["Vertical", "steepness", "vertical"],
      ["Overhung", "steepness", "overhang"],
      ["Roof", "steepness", "roof"],
      ["Tufa", "steepness", "tufa"],
      ["Slab", "other", null],
      ["Unknown", "other", null],
      ["title", "climb_type", null],
    ]);
    expect(result.candidates[0]?.tags[0]).toMatchObject({
      scope: "inherited",
      inheritedFrom: "Cragmont Park",
    });
    expect(result.candidates[0]?.locations).toEqual([
      { externalId: "456", name: "Cragmont Park", scope: "area", coordinates: null },
    ]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      `${origin}/en/climbing/world/search?S=Cragmont%20Crack&only=routes`,
    );
  });

  it("follows pages, deduplicates IDs and only fetches normalized exact names", async () => {
    const fetchFn = client([
      search(row("Different") + row(), "?S=Cragmont%20Crack&only=routes&page=2"),
      search(row("  CRAGMONT  CRACK ")),
      detail(),
    ]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search(seed);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("marks capped searches incomplete", async () => {
    const pages = Array.from({ length: 3 }, (_, i) =>
      search(row("Other"), `?S=Cragmont%20Crack&only=routes&page=${i + 2}`),
    );
    const fetchFn = client(pages);
    expect(await new TheCragCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("marks repeated pagination incomplete", async () => {
    const fetchFn = client([
      search(row("Other"), "?S=Cragmont%20Crack&only=routes&page=2"),
      search(row("Other"), "?S=Cragmont%20Crack&only=routes&page=2"),
    ]);
    expect((await new TheCragCatalogueAdapter(fetchFn).search(seed)).complete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("can fetch a known same-provider source independently of search and recognizes boulders", async () => {
    const fetchFn = client([
      detail("", route, "Cragmont Crack, Boulder problem in Cragmont Park | theCrag"),
    ]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search({
      ...seed,
      providerId: "thecrag",
      externalId: "123",
      sourceUrl: origin + route,
    });
    expect(result.candidates[0]?.kind).toBe("boulder");
    expect(result.complete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("resolves a recorded numeric route ID without a stored URL or a matching old name", async () => {
    const html = detail().replace(
      'itemprop="name">Cragmont Crack',
      'itemprop="name">Renamed Crack',
    );
    const fetchFn = client([html]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search({
      ...seed,
      providerId: "thecrag",
      externalId: "123",
      sourceUrl: null,
    });
    expect(result.candidates[0]).toMatchObject({ externalId: "123", name: "Renamed Crack" });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`${origin}/en/climbing/world/route/123`);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://evil.example/route/123",
    "https://www.thecrag.com@evil.example/route/123",
    `${origin}/en/climbing/area/123`,
  ])("rejects invalid source URL %s before requesting it", async (sourceUrl) => {
    const fetchFn = client([]);
    await expect(
      new TheCragCatalogueAdapter(fetchFn).search({ ...seed, providerId: "thecrag", sourceUrl }),
    ).rejects.toThrow(/source URL/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects foreign pagination before fetching it", async () => {
    const fetchFn = client([search(row("Other"), "https://evil.example/?page=2")]);
    await expect(new TheCragCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(/pagination/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(["<html>Just a moment</html>", "<h1>broken</h1>"])(
    "rejects unavailable search markup",
    async (html) => {
      await expect(new TheCragCatalogueAdapter(client([html])).search(seed)).rejects.toThrow(
        /search page/i,
      );
    },
  );

  it("rejects mismatched route identity", async () => {
    await expect(
      new TheCragCatalogueAdapter(client([search(), detail("", "/en/climbing/route/999")])).search(
        seed,
      ),
    ).rejects.toThrow(/identity/i);
  });

  it("rejects blocked details and HTTP redirects", async () => {
    await expect(
      new TheCragCatalogueAdapter(client([search(), "<html>challenge</html>"])).search(seed),
    ).rejects.toThrow(/route page/i);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("", { status: 302, headers: { location: "https://evil.example" } }),
      );
    await expect(new TheCragCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(/302/);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});

it.each([
  "Trad",
  "Sport",
  "Top rope",
  "Mixed trad",
  "Aid",
  "Boulder",
  "Ice",
  "Unknown source type",
])("retains literal %s catalogue type from the verified route title", async (label) => {
  const suffix = label === "Boulder" ? "problem" : "climb";
  const fetchFn = client([
    search(),
    detail(
      '<div class="ascent"><span class="style">Sport</span></div>',
      route,
      `5.6 ★Cragmont Crack, 10.67m ${label} ${suffix} in Cragmont Park | theCrag`,
    ),
  ]);
  const result = await new TheCragCatalogueAdapter(fetchFn).search(seed);
  expect(result.candidates[0]?.tags).toContainEqual({
    kind: "climb_type",
    sourceKey: "title",
    label,
    category: null,
    scope: "direct",
    inheritedFrom: null,
  });
});
it("preserves multiple route gear styles and ignores other route and ascent styles", async () => {
  const markup = `<div class="band style-band"><a href="${route}/routes/with-gear-style/trad">TRAD</a><a href="${route}/routes/with-gear-style/sport">SPORT</a><a href="/en/climbing/route/999/routes/with-gear-style/aid">AID</a></div><div class="ascent"><a href="${route}/routes/with-gear-style/top-rope">Top rope</a></div>`;
  const result = await new TheCragCatalogueAdapter(client([search(), detail(markup)])).search(seed);
  expect(result.candidates[0]?.tags.filter((tag) => tag.kind === "climb_type")).toEqual([
    {
      kind: "climb_type",
      sourceKey: "route-gear-style:trad",
      label: "TRAD",
      category: null,
      scope: "direct",
      inheritedFrom: null,
    },
    {
      kind: "climb_type",
      sourceKey: "route-gear-style:sport",
      label: "SPORT",
      category: null,
      scope: "direct",
      inheritedFrom: null,
    },
  ]);
});
