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
function lookup(html: string) {
  return new TheCragCatalogueAdapter(client([html])).search({
    ...seed,
    providerId: "thecrag",
    externalId: "123",
  });
}

describe("TheCragCatalogueAdapter", () => {
  it.each(["  CRAGMONT  CRACK  ", "Ｃｒａｇｍｏｎｔ Crack", "Cragmont\t\nCrack"])(
    "finds the sole matching result after normalizing %s",
    async (name) => {
      const fetchFn = client([search(row(name)), detail()]);
      expect((await new TheCragCatalogueAdapter(fetchFn).search(seed)).candidates).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it("does not merge distinct Unicode names when folding case", async () => {
    const fetchFn = client([search(row("STRASSE"))]);
    expect(await new TheCragCatalogueAdapter(fetchFn).search({ ...seed, name: "Straße" })).toEqual({
      candidates: [],
      complete: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://[",
    `https://evil.example${route}`,
    `https://name@www.thecrag.com${route}`,
    `https://:password@www.thecrag.com${route}`,
    `${origin}${route}?extra=1`,
    `${origin}${route}#fragment`,
    `${origin}/prefix${route}`,
    `${origin}${route}/ascents`,
    `${origin}/en/climbing/route/0`,
  ])("rejects unsafe route source %s before any request", async (sourceUrl) => {
    const fetchFn = client([]);
    await expect(
      new TheCragCatalogueAdapter(fetchFn).search({ ...seed, providerId: "thecrag", sourceUrl }),
    ).rejects.toThrow(/source URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resolves trailing-slash route identities and trims name and grade", async () => {
    const html = detail("", `${route}/`)
      .replace('itemprop="name">Cragmont Crack', 'itemprop="name">  Cragmont Crack  ')
      .replace('class="grade">5.6', 'class="grade">  5.6  ');
    const result = await lookup(html);
    expect(result.candidates[0]).toMatchObject({
      externalId: "123",
      name: "Cragmont Crack",
      grade: "5.6",
    });
  });

  it.each([
    detail().replace(/<link[^>]+>/, ""),
    detail(`<link rel="canonical" href="${origin}${route}">`),
    detail().replace('itemprop="name">Cragmont Crack', 'itemprop="name">  '),
  ])("rejects incomplete or conflicting detail identity markup", async (html) => {
    await expect(lookup(html)).rejects.toThrow(/route page/);
  });

  it.each([
    ["Cragmont Crack,Trad climb in Park | theCrag", "route", "Trad"],
    ["Cragmont Crack,   10.67m   Trad climb in Park | theCrag", "route", "Trad"],
    ["Cragmont Crack, Boulder climb in Park | theCrag", "route", "Boulder"],
    ["Cragmont Crack, Unknown problem in Park | theCrag", null, "Unknown"],
    ["Cragmont Crack, Trad climb in Park | theCrag extra", null, null],
    ["Cragmont Crack", null, null],
  ])("classifies only the verified title grammar %s", async (title, kind, label) => {
    const result = await lookup(detail("", route, title ?? ""));
    expect(result.candidates[0]?.kind).toBe(kind);
    expect(result.candidates[0]?.tags).toEqual(
      label
        ? [
            {
              kind: "climb_type",
              sourceKey: "title",
              label,
              category: null,
              scope: "direct",
              inheritedFrom: null,
            },
          ]
        : [],
    );
  });

  it("keeps native tag keys and normalized labels while ignoring unrelated or empty tags", async () => {
    const markup = [
      '<a rel="tag" href="/en/article/tagging#Always%20shady" title="INHERITED FROM   Cragmont Park  ">  Always   shady \n </a>',
      '<a rel="tag" href="/en/article/tagging#Roof" title="not inherited from Park"> Roof </a>',
      '<a rel="tag" href="/en/article/tagging#Ramp" title="inherited from Park&#10;extra">Slab</a>',
      '<a rel="tag" href="/en/article/tagging#Empty">  </a>',
      '<a rel="tag" href="http://[">Invalid URL</a>',
      '<a rel="tag" href="https://evil.example/en/article/tagging#Ramp">Wrong host</a>',
      '<a rel="tag" href="/en/article/other#Ramp">Wrong path</a>',
      '<a rel="tag" href="/en/article/tagging">No key</a>',
    ].join("");
    const result = await lookup(detail(markup, route, "Unknown title"));
    expect(result.candidates[0]?.tags).toEqual([
      {
        sourceKey: "Always shady",
        label: "Always shady",
        kind: "other",
        category: null,
        scope: "inherited",
        inheritedFrom: "Cragmont Park",
      },
      {
        sourceKey: "Roof",
        label: "Roof",
        kind: "steepness",
        category: "roof",
        scope: "direct",
        inheritedFrom: null,
      },
      {
        sourceKey: "Ramp",
        label: "Slab",
        kind: "steepness",
        category: "slab",
        scope: "direct",
        inheritedFrom: null,
      },
    ]);
  });

  it("uses only valid styles on the canonical route and trims their labels", async () => {
    const valid = `${route}/routes/with-gear-style/top-rope`;
    const markup = `<div class="style-band"><a href="${valid}/">  Top   rope  </a>${[
      "http://[",
      `https://evil.example${valid}`,
      `${valid}?filter=1`,
      `${valid}#fragment`,
      `${valid}/extra`,
      "/en/climbing/route/999/routes/with-gear-style/aid",
      "/other",
    ]
      .map((href) => `<a href="${href}">Invalid</a>`)
      .join("")}<a href="${valid}">  </a></div>`;
    const result = await lookup(detail(markup));
    expect(result.candidates[0]?.tags).toEqual([
      {
        kind: "climb_type",
        sourceKey: "route-gear-style:top-rope",
        label: "Top rope",
        category: null,
        scope: "direct",
        inheritedFrom: null,
      },
    ]);
  });

  it("retains only area breadcrumbs and validates optional native area IDs", async () => {
    const crumb = (href: string, name: string, id?: string) =>
      `<a class="crumb__a" href="${href}" ${id === undefined ? "" : `data-nid="${id}"`}><span class="crumb__long">${name}</span></a>`;
    const markup = [
      crumb("http://[", "Malformed"),
      crumb("https://evil.example/en/climbing/area/1", "Foreign"),
      crumb("/en/article/area", "Article"),
      crumb(route, "Route"),
      crumb("/en/climbing/area/1", "  "),
      ...["x123", "123x", "0", undefined].map((id) =>
        crumb("/en/climbing/area/unknown", "  Unknown   area  ", id),
      ),
    ].join("");
    const result = await lookup(detail(markup));
    expect(result.candidates[0]?.locations).toEqual([
      { externalId: "456", name: "Cragmont Park", scope: "area", coordinates: null },
      ...Array.from({ length: 4 }, () => ({
        externalId: null,
        name: "Unknown area",
        scope: "area",
        coordinates: null,
      })),
    ]);
  });

  it("leaves a missing published grade unknown", async () => {
    expect(
      (await lookup(detail().replace('class="grade">5.6', 'class="grade">   '))).candidates[0]
        ?.grade,
    ).toBeNull();
  });

  it.each([
    "http://[",
    "https://evil.example/en/climbing/world/search?S=Cragmont%20Crack&only=routes&page=2",
    "https://name@www.thecrag.com/en/climbing/world/search?S=Cragmont%20Crack&only=routes&page=2",
    "https://:password@www.thecrag.com/en/climbing/world/search?S=Cragmont%20Crack&only=routes&page=2",
    "/other?S=Cragmont%20Crack&only=routes&page=2",
    "?S=Other&only=routes&page=2",
    "?S=Cragmont%20Crack&only=areas&page=2",
    "?S=Cragmont%20Crack&only=routes&page=2#fragment",
    "?S=Cragmont%20Crack&only=routes&page=0",
    "?S=Cragmont%20Crack&only=routes&page=x12",
    "?S=Cragmont%20Crack&only=routes&page=12x",
    "?S=Cragmont%20Crack&only=routes",
    "?S=Cragmont%20Crack&only=routes&page=2&other=1",
    "?S=Cragmont%20Crack&only=routes&page=2&page=3",
  ])("rejects unsafe or inconsistent pagination %s", async (next) => {
    const fetchFn = client([search(row("Other"), next)]);
    await expect(new TheCragCatalogueAdapter(fetchFn).search(seed)).rejects.toThrow(/pagination/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects competing next links", async () => {
    const next = "?S=Cragmont%20Crack&only=routes&page=2";
    const html = search(row("Other"), next).replace(
      "</div>",
      `<li class="next"><a href="${next}">Next</a></li></div>`,
    );
    await expect(new TheCragCatalogueAdapter(client([html])).search(seed)).rejects.toThrow(
      /pagination/,
    );
  });

  it("follows a multi-digit page number and records terminal emptiness", async () => {
    const fetchFn = client([search("", "?S=Cragmont%20Crack&only=routes&page=12"), search("")]);
    expect(await new TheCragCatalogueAdapter(fetchFn).search(seed)).toEqual({
      candidates: [],
      complete: true,
    });
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("page=12");
  });

  it("searches by name when the provider has no source identity, ignoring other providers' IDs", async () => {
    for (const source of [
      { ...seed, providerId: "thecrag" },
      { ...seed, externalId: "foreign", sourceUrl: "https://other.example/climb/foreign" },
    ]) {
      const fetchFn = client([search("")]);
      expect(await new TheCragCatalogueAdapter(fetchFn).search(source)).toEqual({
        candidates: [],
        complete: true,
      });
      expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/world/search?");
    }
  });

  it("rejects conflicting recorded identity before requesting the route", async () => {
    const fetchFn = client([]);
    await expect(
      new TheCragCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "thecrag",
        externalId: "999",
        sourceUrl: origin + route,
      }),
    ).rejects.toThrow(/identity/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("checks returned transport URLs against the exact requested route", async () => {
    for (const responseUrl of [
      `${origin}/en/climbing/world/route/123`,
      "https://evil.example/en/climbing/world/route/123",
    ]) {
      const response = new Response(detail());
      Object.defineProperty(response, "url", { value: responseUrl });
      const adapter = new TheCragCatalogueAdapter(
        vi.fn<typeof fetch>().mockResolvedValue(response),
      );
      const operation = adapter.search({ ...seed, providerId: "thecrag", externalId: "123" });
      if (responseUrl.startsWith(origin))
        expect((await operation).candidates[0]?.externalId).toBe("123");
      else await expect(operation).rejects.toThrow(/response URL/);
    }
  });
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
