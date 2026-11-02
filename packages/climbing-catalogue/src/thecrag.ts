import { type CheerioAPI, load } from "cheerio";
import { cataloguePlainText } from "./area-context.ts";
import type {
  CatalogueAreaContext,
  CatalogueCandidate,
  CatalogueLocation,
  CatalogueSearchResult,
  CatalogueSeed,
  ClimbingCatalogueAdapter,
} from "./contracts.ts";
import { catalogueNameMatch, catalogueSearchNames } from "./matching.ts";

const ORIGIN = "https://www.thecrag.com";
const SEARCH_PATH = "/en/climbing/world/search";
const MAX_PAGES = 3;
const MAX_ROUTES = 60;
const steepness: Record<string, string> = {
  Ramp: "slab",
  Vertical: "vertical",
  Overhung: "overhang",
  Roof: "roof",
  Tufa: "tufa",
};

function routeUrl(value: string): URL {
  const url = URL.canParse(value, ORIGIN) ? new URL(value, ORIGIN) : null;
  if (
    !url ||
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/en\/climbing\/(?:[^/]+\/)*route\/[1-9]\d*\/?$/.test(url.pathname)
  )
    throw new Error(
      "theCrag returned an invalid catalogue source URL. Use a public theCrag route URL.",
    );
  return url;
}

function routeId(url: URL): string {
  return url.pathname.split("/").filter(Boolean).at(-1) ?? "";
}

function areaUrl(value: string, id: string | null): URL | null {
  const url = URL.canParse(value, ORIGIN) ? new URL(value, ORIGIN) : null;
  return url &&
    url.origin === ORIGIN &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/en\/climbing\/(?:[^/]+\/)*area\/[1-9]\d*\/?$/.test(url.pathname) &&
    routeId(url) === id
    ? url
    : null;
}

function parseTags(
  $: CheerioAPI,
  elements: ReturnType<CheerioAPI>,
  inherited: string | null = null,
): CatalogueCandidate["tags"] {
  const tags: CatalogueCandidate["tags"] = [];
  for (const element of elements.toArray()) {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (!URL.canParse(href, ORIGIN)) continue;
    const url = new URL(href, ORIGIN);
    if (
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.pathname !== "/en/article/tagging" ||
      !url.hash ||
      /%(?![0-9a-f]{2})/i.test(url.hash)
    )
      continue;
    const sourceKey = decodeURIComponent(url.hash.slice(1)).trim();
    const label = anchor.text().replace(/\s+/g, " ").trim();
    if (!sourceKey || !label) continue;
    const inheritedFrom =
      /^inherited from (.+)$/i.exec(anchor.attr("title") ?? "")?.[1]?.trim() || inherited;
    const category = steepness[sourceKey] ?? null;
    tags.push({
      sourceKey,
      label,
      kind: category ? "steepness" : "other",
      category,
      scope: inheritedFrom ? "inherited" : "direct",
      inheritedFrom,
    });
  }
  return tags;
}

function areaCoordinates($: CheerioAPI): CatalogueLocation["coordinates"] {
  const latitude = $('meta[property="place:location:latitude"]');
  const longitude = $('meta[property="place:location:longitude"]');
  const lat = latitude.attr("content") ?? "";
  const lon = longitude.attr("content") ?? "";
  if (
    latitude.length !== 1 ||
    longitude.length !== 1 ||
    !/^-?\d+(?:\.\d+)?$/.test(lat) ||
    !/^-?\d+(?:\.\d+)?$/.test(lon)
  )
    return null;
  const point = { latitude: Number(lat), longitude: Number(lon) };
  return Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180 ? point : null;
}

function parseArea(
  html: string,
  expected: URL,
): Pick<CatalogueLocation, "coordinates" | "context"> {
  const $ = load(html);
  const canonical = $('link[rel="canonical"]');
  const identity =
    canonical.length === 1 ? areaUrl(canonical.attr("href") ?? "", routeId(expected)) : null;
  if (!identity)
    throw new Error(
      "theCrag catalogue parent area identity is unavailable or invalid. Retry later.",
    );
  const context: CatalogueAreaContext = {
    url: identity.href,
    type: cataloguePlainText(
      $('.regions__title h1 .heading__byline .info > a[href="/en/article/areatypes"]').html(),
    ),
    sections: [],
    tags: [],
    statistics: [],
  };
  const sectionTypes: Record<string, string> = {
    description: "Description",
    "access-issues": "Access issues",
    approach: "Approach",
    "unique-features-and-strengths": "Summary",
    history: "History",
  };
  for (const element of $(".regions__read > .regions__inner > .node-info").toArray()) {
    const section = $(element);
    const ancestor = section.children("h2").find("small.from > a.inherit-from");
    const href = ancestor.attr("href") ?? "";
    const ancestorUrl = URL.canParse(href, ORIGIN) ? new URL(href, ORIGIN) : null;
    const inheritedFrom =
      ancestor.length === 1 &&
      ancestorUrl?.origin === ORIGIN &&
      !ancestorUrl.username &&
      !ancestorUrl.password &&
      !ancestorUrl.search &&
      !ancestorUrl.hash &&
      ancestorUrl.pathname.startsWith("/en/climbing/")
        ? cataloguePlainText(ancestor.html())
        : null;
    const content = section.children(".content");
    context.tags.push(
      ...parseTags(
        $,
        content
          .find('a[rel~="tag"]')
          .filter((_, anchor) => $(anchor).closest(".node-info")[0] === element),
        inheritedFrom,
      ).map((tag) => ({
        ...tag,
        count: null,
      })),
    );
    const sourceKey = Object.keys(sectionTypes).find((key) => section.hasClass(key));
    if (!sourceKey) continue;
    const text = cataloguePlainText(content.children(".markdown").html());
    if (text)
      context.sections.push({
        sourceKey,
        label: sectionTypes[sourceKey] ?? sourceKey,
        text,
        inheritedFrom,
      });
  }
  for (const element of $(".regions__title h1 .heading__byline .info > a[href]").toArray()) {
    const anchor = $(element);
    const url = URL.canParse(anchor.attr("href") ?? "", ORIGIN)
      ? new URL(anchor.attr("href") ?? "", ORIGIN)
      : null;
    const match = /^(\d[\d,]*) routes?$/i.exec(anchor.text().replace(/\s+/g, " ").trim());
    if (
      url?.origin === ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith("/routes") &&
      areaUrl(url.pathname.slice(0, -7), routeId(identity)) &&
      match
    ) {
      context.statistics.push({
        sourceKey: "routes",
        label: "Routes",
        value: Number(match[1]?.replaceAll(",", "")),
      });
    }
  }
  return {
    coordinates: areaCoordinates($),
    ...(context.type || context.sections.length || context.tags.length || context.statistics.length
      ? { context }
      : {}),
  };
}

function parseDetail(
  html: string,
  expected: URL,
): { candidate: CatalogueCandidate; areas: Map<string, URL> } {
  const $ = load(html);
  const name = $("h1 [itemprop=name]").text().trim();
  const canonical = $('link[rel="canonical"]');
  if (!name || canonical.length !== 1)
    throw new Error(
      "theCrag catalogue route page is blocked or unavailable. Retry when public access is available.",
    );
  const identity = routeUrl(canonical.attr("href") ?? "");
  if (routeId(identity) !== routeId(expected))
    throw new Error(
      "theCrag catalogue route identity does not match the requested climb. Retry or check its source URL.",
    );
  const title = $("title").text();
  const titleType = /,\s*(?:[\d.]+m\s+)?([^,|]+?) (climb|problem) in [^|]+ \| theCrag$/.exec(title);
  const kind =
    titleType?.[1] === "Boulder" && titleType[2] === "problem"
      ? "boulder"
      : titleType?.[2] === "climb"
        ? "route"
        : null;
  const tags = parseTags($, $('a[rel~="tag"]'));
  // The route's own gear-style band describes catalogue facts, not personal ascent methods.
  for (const element of $(".style-band a[href]").toArray()) {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (!URL.canParse(href, ORIGIN)) continue;
    const url = new URL(href, ORIGIN);
    const path = /^(.*)\/routes\/with-gear-style\/([^/]+)\/?$/.exec(url.pathname);
    if (
      url.origin !== ORIGIN ||
      url.search ||
      url.hash ||
      !path ||
      path[1] !== identity.pathname.replace(/\/$/, "")
    )
      continue;
    const label = anchor.text().replace(/\s+/g, " ").trim();
    if (!label) continue;
    tags.push({
      kind: "climb_type",
      sourceKey: `route-gear-style:${path[2]}`,
      label,
      category: null,
      scope: "direct",
      inheritedFrom: null,
    });
  }
  // Verified route titles provide a literal type when the structured band is unavailable.
  if (!tags.some((tag) => tag.kind === "climb_type") && titleType?.[1]) {
    tags.push({
      kind: "climb_type",
      sourceKey: "title",
      label: titleType[1],
      category: null,
      scope: "direct",
      inheritedFrom: null,
    });
  }
  const locations: CatalogueCandidate["locations"] = [];
  const areas = new Map<string, URL>();
  for (const element of $("a.crumb__a").toArray()) {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (!URL.canParse(href, ORIGIN)) continue;
    const url = new URL(href, ORIGIN);
    if (
      url.origin !== ORIGIN ||
      !url.pathname.startsWith("/en/climbing/") ||
      /\/route\//.test(url.pathname)
    )
      continue;
    const areaName = anchor.find(".crumb__long").text().replace(/\s+/g, " ").trim();
    if (!areaName) continue;
    const id = anchor.attr("data-nid");
    locations.push({
      externalId: id && /^[1-9]\d*$/.test(id) ? id : null,
      name: areaName,
      scope: "area",
      coordinates: null,
    });
    const nativeId = locations.at(-1)?.externalId;
    const canonicalArea = areaUrl(href, nativeId ?? null);
    if (
      nativeId &&
      (canonicalArea ||
        (!url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          !url.pathname.includes("/area/")))
    )
      areas.set(nativeId, canonicalArea ?? new URL(`${ORIGIN}/en/climbing/world/area/${nativeId}`));
  }
  const aliases = $('.headline__guts > ul.stats > li[title="Alternate name"]')
    .toArray()
    .map((element) => {
      const alias = $(element).clone();
      alias.find("strong").remove();
      return alias.text().replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);
  const candidate: CatalogueCandidate = {
    providerId: "thecrag",
    externalId: routeId(identity),
    url: identity.href,
    name,
    ...(aliases.length ? { aliases: [...new Set(aliases)] } : {}),
    kind,
    setting: null,
    locations,
    grade: $("h1 .grade").text().trim() || null,
    angle: null,
    tags,
  };
  return { candidate, areas };
}

/** Public catalogue reads only; the caller owns request telemetry and transport. */
export class TheCragCatalogueAdapter implements ClimbingCatalogueAdapter {
  readonly providerId = "thecrag" as const;

  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  async #page(url: URL): Promise<string> {
    const response = await this.#fetchFn(url.href, { method: "GET", redirect: "manual" });
    if (!response.ok)
      throw new Error(
        `theCrag catalogue request failed (HTTP ${response.status}). Retry when public access is available.`,
      );
    if (response.url && response.url !== url.href)
      throw new Error(
        "theCrag catalogue returned an unexpected response URL. Retry when public access is available.",
      );
    return response.text();
  }

  async #detail(
    url: URL,
    areas: Map<string, Pick<CatalogueLocation, "coordinates" | "context">>,
  ): Promise<CatalogueCandidate> {
    const { candidate, areas: parents } = parseDetail(await this.#page(url), url);
    for (const location of candidate.locations) {
      const parent = location.externalId ? parents.get(location.externalId) : null;
      if (!parent || !location.externalId) continue;
      if (!areas.has(location.externalId))
        areas.set(location.externalId, parseArea(await this.#page(parent), parent));
      Object.assign(location, areas.get(location.externalId));
    }
    return candidate;
  }

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    const areas = new Map<string, Pick<CatalogueLocation, "coordinates" | "context">>();
    if (seed.providerId === this.providerId && (seed.sourceUrl || seed.externalId)) {
      const url = routeUrl(
        seed.sourceUrl ?? `${ORIGIN}/en/climbing/world/route/${seed.externalId}`,
      );
      if (seed.externalId && routeId(url) !== seed.externalId)
        throw new Error(
          "theCrag catalogue source identity does not match the recorded climb. Check its source URL.",
        );
      return { candidates: [await this.#detail(url, areas)], complete: false };
    }
    const names = catalogueSearchNames(seed);
    const pending = names.map((name) => ({
      name,
      url: new URL(`${ORIGIN}${SEARCH_PATH}?S=${encodeURIComponent(name)}&only=routes`),
      visited: new Set<string>(),
      seen: new Set<string>(),
    }));
    const routes = new Map<string, URL>();
    let partial = false;
    for (let page = 0; page < MAX_PAGES && pending.length; page++) {
      const query = pending.shift();
      if (!query) break;
      const current = query.url;
      query.visited.add(current.href);
      const $ = load(await this.#page(current));
      if ($("table.routetable").length !== 1)
        throw new Error(
          "theCrag catalogue search page is blocked or unsupported. Retry when public access is available.",
        );
      for (const element of $("table.routetable .rt_name .route a[href]").toArray()) {
        const url = routeUrl($(element).attr("href") ?? "");
        if (query.seen.has(routeId(url))) {
          partial = true;
          continue;
        }
        query.seen.add(routeId(url));
        if (routes.has(routeId(url))) continue;
        if (routes.size >= MAX_ROUTES) {
          partial = true;
          continue;
        }
        routes.set(routeId(url), url);
      }
      const next = $(".pagination li.next:not(.disabled) a[href]");
      if (!next.length) continue;
      const href = next.attr("href") ?? "";
      const url = URL.canParse(href, current) ? new URL(href, current) : null;
      if (
        next.length !== 1 ||
        !url ||
        url.origin !== ORIGIN ||
        url.username ||
        url.password ||
        url.pathname !== SEARCH_PATH ||
        url.hash ||
        url.searchParams.get("S") !== query.name ||
        url.searchParams.get("only") !== "routes" ||
        !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "") ||
        [...url.searchParams.keys()].some((key) => !["S", "only", "page"].includes(key)) ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
      )
        throw new Error(
          "theCrag returned an invalid catalogue pagination URL. Retry or contact support.",
        );
      if (query.visited.has(url.href)) partial = true;
      else {
        query.url = url;
        pending.push(query);
      }
    }
    const candidates: CatalogueCandidate[] = [];
    for (const url of routes.values()) {
      const candidate = await this.#detail(url, areas);
      if (names.some((name) => catalogueNameMatch(name, candidate) !== null))
        candidates.push(candidate);
    }
    return { candidates, complete: pending.length === 0 && !partial };
  }
}
