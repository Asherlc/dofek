import type {
  CatalogueCandidate,
  CatalogueLocation,
  CatalogueSearchResult,
  CatalogueSeed,
  ClimbingCatalogueAdapter,
} from "@dofek/training/climbing-catalogue";
import { load } from "cheerio";
import { catalogueNameMatch } from "../../climbing-catalogue-matching.ts";

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

function areaCoordinates(html: string, expected: URL): CatalogueLocation["coordinates"] {
  const $ = load(html);
  const canonical = $('link[rel="canonical"]');
  if (canonical.length !== 1 || !areaUrl(canonical.attr("href") ?? "", routeId(expected)))
    throw new Error(
      "theCrag catalogue parent area identity is unavailable or invalid. Retry later.",
    );
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

function parseDetail(
  html: string,
  expected: URL,
): { candidate: CatalogueCandidate; parent: URL | null } {
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
  const tags: CatalogueCandidate["tags"] = [];
  for (const element of $('a[rel~="tag"]').toArray()) {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (!URL.canParse(href, ORIGIN)) continue;
    const url = new URL(href, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname !== "/en/article/tagging" || !url.hash) continue;
    const sourceKey = decodeURIComponent(url.hash.slice(1));
    const label = anchor.text().replace(/\s+/g, " ").trim();
    if (!label) continue;
    const inheritedFrom =
      /^inherited from (.+)$/i.exec(anchor.attr("title") ?? "")?.[1]?.trim() ?? null;
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
  let parent: URL | null = null;
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
    parent = areaUrl(href, locations.at(-1)?.externalId ?? null);
  }
  const displayed = $("#location")
    .closest("h3")
    .next("dl.areaInfo")
    .find("dd")
    .toArray()
    .map((element) =>
      /^\s*Lat\/Lon:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec($(element).text()),
    )
    .filter((match) => match !== null);
  let hasDisplayedPoint = false;
  if (displayed.length === 1) {
    const latitude = Number(displayed[0]?.[1]);
    const longitude = Number(displayed[0]?.[2]);
    if (
      Number.isFinite(latitude) &&
      Math.abs(latitude) <= 90 &&
      Number.isFinite(longitude) &&
      Math.abs(longitude) <= 180
    )
      hasDisplayedPoint = true;
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
  return { candidate, parent: hasDisplayedPoint ? parent : null };
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
    areas: Map<string, CatalogueLocation["coordinates"]>,
  ): Promise<CatalogueCandidate> {
    const { candidate, parent } = parseDetail(await this.#page(url), url);
    const nearest = candidate.locations.at(-1);
    if (parent && nearest) {
      const id = routeId(parent);
      if (!areas.has(id)) areas.set(id, areaCoordinates(await this.#page(parent), parent));
      nearest.coordinates = areas.get(id) ?? null;
    }
    return candidate;
  }

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    const areas = new Map<string, CatalogueLocation["coordinates"]>();
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
    const initial = new URL(
      `${ORIGIN}${SEARCH_PATH}?S=${encodeURIComponent(seed.name)}&only=routes`,
    );
    let current = initial;
    const visited = new Set<string>();
    const routes = new Map<string, URL>();
    let complete = false;
    let partial = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (visited.has(current.href)) break;
      visited.add(current.href);
      const $ = load(await this.#page(current));
      if ($("table.routetable").length !== 1)
        throw new Error(
          "theCrag catalogue search page is blocked or unsupported. Retry when public access is available.",
        );
      for (const element of $("table.routetable .rt_name .route a[href]").toArray()) {
        const url = routeUrl($(element).attr("href") ?? "");
        if (routes.has(routeId(url))) {
          partial = true;
          continue;
        }
        if (routes.size >= MAX_ROUTES) {
          partial = true;
          continue;
        }
        routes.set(routeId(url), url);
      }
      const next = $(".pagination li.next:not(.disabled) a[href]");
      if (!next.length) {
        complete = true;
        break;
      }
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
        url.searchParams.get("S") !== seed.name ||
        url.searchParams.get("only") !== "routes" ||
        !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "") ||
        [...url.searchParams.keys()].some((key) => !["S", "only", "page"].includes(key)) ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
      )
        throw new Error(
          "theCrag returned an invalid catalogue pagination URL. Retry or contact support.",
        );
      current = url;
    }
    const candidates: CatalogueCandidate[] = [];
    for (const url of routes.values()) {
      const candidate = await this.#detail(url, areas);
      if (
        [seed.name, ...(seed.aliases ?? [])].some(
          (name) => catalogueNameMatch(name, candidate) !== null,
        )
      )
        candidates.push(candidate);
    }
    return { candidates, complete: complete && !partial };
  }
}
