import type {
  CatalogueCandidate,
  CatalogueSearchResult,
  CatalogueSeed,
  ClimbingCatalogueAdapter,
} from "@dofek/training/climbing-catalogue";
import { load } from "cheerio";

const ORIGIN = "https://www.thecrag.com";
const SEARCH_PATH = "/en/climbing/world/search";
const MAX_PAGES = 3;
const steepness: Record<string, string> = {
  Ramp: "slab",
  Vertical: "vertical",
  Overhung: "overhang",
  Roof: "roof",
  Tufa: "tufa",
};

function normalizedName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

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

function parseDetail(html: string, expected: URL): CatalogueCandidate {
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
  }
  return {
    providerId: "thecrag",
    externalId: routeId(identity),
    url: identity.href,
    name,
    kind,
    setting: null,
    locations,
    grade: $("h1 .grade").text().trim() || null,
    angle: null,
    tags,
  };
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

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    if (seed.providerId === this.providerId && (seed.sourceUrl || seed.externalId)) {
      const url = routeUrl(
        seed.sourceUrl ?? `${ORIGIN}/en/climbing/world/route/${seed.externalId}`,
      );
      if (seed.externalId && routeId(url) !== seed.externalId)
        throw new Error(
          "theCrag catalogue source identity does not match the recorded climb. Check its source URL.",
        );
      return { candidates: [parseDetail(await this.#page(url), url)], complete: false };
    }
    const initial = new URL(
      `${ORIGIN}${SEARCH_PATH}?S=${encodeURIComponent(seed.name)}&only=routes`,
    );
    let current = initial;
    const visited = new Set<string>();
    const routes = new Map<string, URL>();
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (visited.has(current.href)) break;
      visited.add(current.href);
      const $ = load(await this.#page(current));
      if ($("table.routetable").length !== 1)
        throw new Error(
          "theCrag catalogue search page is blocked or unsupported. Retry when public access is available.",
        );
      for (const element of $("table.routetable .rt_name .route a[href]").toArray()) {
        const anchor = $(element).clone();
        anchor.find(".star").remove();
        if (normalizedName(anchor.text()) !== normalizedName(seed.name)) continue;
        const url = routeUrl(anchor.attr("href") ?? "");
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
    for (const url of routes.values()) candidates.push(parseDetail(await this.#page(url), url));
    return { candidates, complete };
  }
}
