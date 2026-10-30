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
  it("does not claim complete coverage when a fourth name remains after three empty queries", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (input) =>
          new Response(
            search(
              new URL(String(input)).searchParams.get("S") === "Left start"
                ? row("Left start")
                : "",
            ),
          ),
      );
    expect(
      await new TheCragCatalogueAdapter(fetchFn).search({
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
        if (url.pathname.includes("/route/"))
          return new Response(
            detail().replace('itemprop="name">Cragmont Crack', 'itemprop="name">Up'),
          );
        return new Response(search(url.searchParams.get("S") === "Up" || overlap ? row("Up") : ""));
      });
      const result = await new TheCragCatalogueAdapter(fetchFn).search({
        ...seed,
        aliases: ["", "  CRAGMONT   crack ", "Up", " up "],
      });
      expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Up"]);
      expect(result.complete).toBe(true);
      expect(
        fetchFn.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("S")),
      ).toEqual(["Cragmont Crack", "Up", null]);
    },
  );
  it("shares three pages across aliases before paginating and reports uncovered names", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(
        search(
          "",
          url.searchParams.get("S") === seed.name ? "?S=Cragmont%20Crack&only=routes&page=2" : "",
        ),
      );
    });
    const result = await new TheCragCatalogueAdapter(fetchFn).search({
      ...seed,
      aliases: ["Up", "Down", "Left start"],
    });
    expect(result.complete).toBe(false);
    expect(
      fetchFn.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("S")),
    ).toEqual(["Cragmont Crack", "Up", "Down"]);
  });
  it("resumes validated per-query pagination after giving aliases an initial page", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(
        search(
          "",
          url.searchParams.get("S") === seed.name && !url.searchParams.has("page")
            ? "?S=Cragmont%20Crack&only=routes&page=2"
            : "",
        ),
      );
    });
    expect(
      (await new TheCragCatalogueAdapter(fetchFn).search({ ...seed, aliases: ["Up"] })).complete,
    ).toBe(true);
    expect(
      fetchFn.mock.calls.map(([input]) => {
        const url = new URL(String(input));
        return [url.searchParams.get("S"), url.searchParams.get("page")];
      }),
    ).toEqual([
      ["Cragmont Crack", null],
      ["Up", null],
      ["Cragmont Crack", "2"],
    ]);
  });
  it.each(["Great Roof, The", "The Great Roofs", "The Great Roof extension"])(
    "retains name-related suggestion %s with qualifiers intact",
    async (name) => {
      const fetchFn = client([
        search(row(name)),
        detail().replace("Cragmont Crack</span>", `${name}</span>`),
      ]);
      expect(
        (await new TheCragCatalogueAdapter(fetchFn).search({ ...seed, name: "The Great Roof" }))
          .candidates[0]?.name,
      ).toBe(name);
    },
  );
  it("retains only literal route AKA labels from the verified headline scope", async () => {
    const html = detail(
      '<span itemprop="alternateName">Wrong breadcrumb alias</span><div class="headline__guts"><ul class="stats"><li title="Alternate name"><strong>Aka:</strong> Up</li></ul></div><li title="Alternate name"><strong>Aka:</strong> Wrong other scope</li>',
    );
    expect((await lookup(html)).candidates[0]?.aliases).toEqual(["Up"]);
  });
  it("discovers source-declared AKA matches even when the search title is unrelated", async () => {
    const fetchFn = client([
      search(row("Tall Wall")),
      detail(
        '<div class="headline__guts"><ul class="stats"><li title="Alternate name"><strong>Aka:</strong> Up</li></ul></div>',
      ).replace('itemprop="name">Cragmont Crack', 'itemprop="name">Tall Wall'),
    ]);
    expect(
      (await new TheCragCatalogueAdapter(fetchFn).search({ ...seed, name: "Up" })).candidates[0],
    ).toMatchObject({ name: "Tall Wall", aliases: ["Up"] });
  });
  it("caps unique detail hydration without treating an omitted route as evidence of uniqueness", async () => {
    const rows = Array.from({ length: 61 }, (_, i) =>
      row("Cragmont Crack", `/en/climbing/world/route/${i + 1}`),
    ).join("");
    const fetchFn = client([
      search(rows),
      ...Array.from({ length: 60 }, (_, i) => detail("", `/en/climbing/world/route/${i + 1}`)),
    ]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search(seed);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(60);
    expect(fetchFn).toHaveBeenCalledTimes(61);
  });
  it.each([
    ["Lat/Lon:", "37.22828, -122.10797", null],
    ["Lat/Lon:", "137.22828, -122.10797", null],
    ["Lat/Lon:", "37.22828, -222.10797", null],
    ["Longitude:", "37.22828, -122.10797", null],
    ["Lat/Lon:", "37.22828", null],
  ])(
    "keeps route-only displayed %s %s out of area geography without a verified parent",
    async (label, pair, coordinates) => {
      const html = detail(
        `<meta property="place:location:latitude" content="40"><h3><span id="location">Location</span></h3><dl class="areaInfo"><dd>${label} ${pair}</dd></dl>`,
      ).replace("Cragmont Park</span>", "Goat Rock</span>");
      const fetchFn = client([
        html,
        '<link rel="canonical" href="https://www.thecrag.com/en/climbing/area/456"><h1>Goat Rock</h1>',
      ]);
      const result = await new TheCragCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "thecrag",
        externalId: "123",
      });
      expect(result.candidates[0]?.locations).toEqual([
        { externalId: "456", name: "Goat Rock", scope: "area", coordinates },
      ]);
      expect(result.candidates[0]?.setting).toBeNull();
    },
  );
  it.each([
    ["37.22828, -122.10797", "37.22827985362", "-122.10796556377"],
    ["37.24, -122.11", "37.22827985362", "-122.10796556377"],
  ])(
    "uses the verified parent point independently of a route's displayed %s",
    async (displayed, latitude, longitude) => {
      const routePath = "/en/climbing/united-states/castle-rock-state-park/route/18578485";
      const parentPath = "/en/climbing/united-states/castle-rock-state-park/area/16447255";
      const html = detail(
        `<h3><a id="location"></a>Location</h3><dl class="areaInfo"><dd>Lat/Lon: ${displayed}</dd></dl>`,
        routePath,
      )
        .replace(
          'href="/en/climbing/area/456" data-nid="456"',
          `href="${parentPath}" data-nid="16447255"`,
        )
        .replace("Cragmont Park</span>", "Goat Rock</span>");
      const parent = `<link rel="canonical" href="${origin}${parentPath}"><h1>Goat Rock</h1><meta property="place:location:latitude" content="${latitude}"><meta property="place:location:longitude" content="${longitude}">`;
      const fetchFn = client([html, parent]);
      const result = await new TheCragCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "thecrag",
        externalId: "18578485",
        sourceUrl: origin + routePath,
      });
      expect(result.candidates[0]?.locations).toEqual([
        {
          externalId: "16447255",
          name: "Goat Rock",
          scope: "area",
          coordinates: { latitude: 37.22827985362, longitude: -122.10796556377 },
        },
      ]);
      expect(String(fetchFn.mock.calls[1]?.[0])).toBe(origin + parentPath);
    },
  );
  it("deduplicates parent area reads across routes in one bounded search", async () => {
    const location =
      '<h3><a id="location"></a>Location</h3><dl class="areaInfo"><dd>Lat/Lon: 37.22828, -122.10797</dd></dl>';
    const parent = `<link rel="canonical" href="${origin}/en/climbing/area/456"><meta property="place:location:latitude" content="37.22827985362"><meta property="place:location:longitude" content="-122.10796556377">`;
    const fetchFn = client([
      search(row() + row("Cragmont Crack", "/en/climbing/united-states/route/124")),
      detail(location),
      parent,
      detail(location, "/en/climbing/united-states/route/124"),
    ]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search(seed);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.locations[0]?.coordinates)).toEqual([
      { latitude: 37.22827985362, longitude: -122.10796556377 },
      { latitude: 37.22827985362, longitude: -122.10796556377 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
  it("reports unavailable parent HTTP reads without substituting a route point", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          detail(
            '<h3><a id="location"></a>Location</h3><dl class="areaInfo"><dd>Lat/Lon: 37.24, -122.11</dd></dl>',
          ),
        ),
      )
      .mockResolvedValueOnce(new Response("Unavailable", { status: 404 }));
    await expect(
      new TheCragCatalogueAdapter(fetchFn).search({
        ...seed,
        providerId: "thecrag",
        externalId: "123",
      }),
    ).rejects.toThrow(/theCrag.*HTTP 404/);
  });
  it.each(["  CRAGMONT  CRACK  ", "Ｃｒａｇｍｏｎｔ Crack", "Cragmont\t\nCrack"])(
    "finds the sole matching result after normalizing %s",
    async (name) => {
      const fetchFn = client([search(row(name)), detail()]);
      expect((await new TheCragCatalogueAdapter(fetchFn).search(seed)).candidates).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it("does not merge distinct Unicode names when folding case", async () => {
    const fetchFn = client([
      search(row("STRASSE")),
      detail().replace('itemprop="name">Cragmont Crack', 'itemprop="name">STRASSE'),
    ]);
    expect(await new TheCragCatalogueAdapter(fetchFn).search({ ...seed, name: "Straße" })).toEqual({
      candidates: [],
      complete: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
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
      if (new URL(responseUrl).origin === origin)
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

  it("follows pages and retains unique IDs while repeated rows keep discovery incomplete", async () => {
    const fetchFn = client([
      search(row("Different") + row(), "?S=Cragmont%20Crack&only=routes&page=2"),
      search(row("  CRAGMONT  CRACK ")),
      detail(),
    ]);
    const result = await new TheCragCatalogueAdapter(fetchFn).search(seed);
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("marks capped searches incomplete", async () => {
    const pages = Array.from({ length: 3 }, (_, i) =>
      search("", `?S=Cragmont%20Crack&only=routes&page=${i + 2}`),
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
      search("", "?S=Cragmont%20Crack&only=routes&page=2"),
      search("", "?S=Cragmont%20Crack&only=routes&page=2"),
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
