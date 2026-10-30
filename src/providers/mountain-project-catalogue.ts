import {
  type CatalogueCandidate,
  type CatalogueSearchResult,
  type CatalogueSeed,
  type ClimbingCatalogueAdapter,
  catalogueCandidateSchema,
} from "@dofek/training/climbing-catalogue";
import { z } from "zod";
import { catalogueNameMatch, catalogueSearchNames } from "../climbing-catalogue-matching.ts";

const origin = "https://www.mountainproject.com";
const coordinates = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const routeUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.origin === origin &&
    !url.username &&
    !url.password &&
    /^\/route\/\d+(?:\/[^/]*)?$/.test(url.pathname)
  );
});
const hitSchema = z.object({
  id: z.string().regex(/^routes\.\d+$/),
  type: z.literal("Route"),
  title: z.string().min(1),
  url: routeUrl,
  breadcrumbs: z.string(),
  difficulty: z.object({ string: z.string() }).nullish(),
  location: coordinates.nullish(),
  tags: z.array(z.string()),
});
const searchSchema = z.object({
  total: z.object({ value: z.number().int().nonnegative(), relation: z.enum(["eq", "gte"]) }),
  hits: z.array(z.object({ _source: hitSchema })),
});
const detailSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  url: routeUrl,
  parent: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    coordinates: coordinates.nullish(),
  }),
  difficulty: z.string().nullish(),
  types: z.array(z.string()),
});
function tags(types: string[]): CatalogueCandidate["tags"] {
  return types.map((label) => ({
    kind: "climb_type",
    sourceKey: "type",
    label,
    category: null,
    scope: "direct",
    inheritedFrom: null,
  }));
}
function position(point: z.infer<typeof coordinates> | null | undefined) {
  return point ? { longitude: point[0], latitude: point[1] } : null;
}
function hitCandidate(hit: z.infer<typeof hitSchema>): CatalogueCandidate {
  return catalogueCandidateSchema.parse({
    providerId: "mountain-project",
    externalId: hit.id.slice(7),
    url: hit.url,
    name: hit.title,
    kind: hit.tags.includes("Boulder") ? "boulder" : "route",
    setting: "outdoor",
    grade: hit.difficulty?.string ?? null,
    angle: null,
    tags: tags(hit.tags),
    locations: hit.breadcrumbs
      ? [
          {
            externalId: null,
            name: hit.breadcrumbs.split(" > ").at(-1),
            scope: "area",
            coordinates: position(hit.location),
          },
        ]
      : [],
  });
}

export class MountainProjectCatalogueAdapter implements ClimbingCatalogueAdapter {
  readonly providerId = "mountain-project";
  readonly #fetchFn: typeof fetch;
  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  async #request(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#fetchFn(url, { ...init, redirect: "error" });
    if (!response.ok)
      throw new Error(
        `Mountain Project catalogue request failed (HTTP ${response.status}); retry catalogue enrichment later.`,
      );
    if (response.redirected || (response.url && new URL(response.url).origin !== origin))
      throw new Error("Mountain Project catalogue returned an unexpected redirect.");
    return response.json().then(undefined, (cause: unknown) => {
      throw new Error("Mountain Project catalogue returned malformed JSON; retry later.", {
        cause,
      });
    });
  }

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    const reference = seed.references?.find(
      (reference) => reference.providerId === this.providerId,
    );
    const source =
      seed.providerId === this.providerId
        ? { ...seed, externalId: seed.externalId ?? reference?.externalId ?? null }
        : reference
          ? { ...seed, externalId: reference.externalId, sourceUrl: null }
          : null;
    if (source) {
      if (source.externalId !== null && !/^\d+$/.test(source.externalId))
        throw new Error("Mountain Project catalogue source ID must be numeric.");
      if (source.sourceUrl && !routeUrl.safeParse(source.sourceUrl).success)
        throw new Error(
          "Mountain Project catalogue source URL must be a Mountain Project route URL.",
        );
      if (source.externalId) {
        if (
          source.sourceUrl &&
          new URL(source.sourceUrl).pathname.split("/")[2] !== source.externalId
        )
          throw new Error("Mountain Project catalogue source URL and route ID disagree.");
        const detail = detailSchema.safeParse(
          await this.#request(`${origin}/api/v2/routes/${source.externalId}`),
        );
        if (!detail.success || String(detail.data.id) !== source.externalId)
          throw new Error(
            "Mountain Project catalogue returned invalid route details; retry later.",
          );
        const route = detail.data;
        if (new URL(route.url).pathname.split("/")[2] !== source.externalId)
          throw new Error("Mountain Project catalogue returned inconsistent route identity.");
        const candidate = catalogueCandidateSchema.parse({
          providerId: this.providerId,
          externalId: String(route.id),
          url: route.url,
          name: route.title,
          kind: route.types.includes("Boulder") ? "boulder" : "route",
          setting: "outdoor",
          grade: route.difficulty ?? null,
          angle: null,
          tags: tags(route.types),
          locations: [
            {
              externalId: String(route.parent.id),
              name: route.parent.name,
              scope: "area",
              coordinates: position(route.parent.coordinates),
            },
          ],
        });
        return { candidates: [candidate], complete: true };
      }
    }
    const candidates: CatalogueCandidate[] = [];
    const seen = new Set<string>();
    const pending = catalogueSearchNames(seed).map((name) => ({
      name,
      from: 0,
      seen: new Set<string>(),
    }));
    let partial = false;
    for (let page = 0; page < 3 && pending.length; page++) {
      const current = pending.shift();
      if (!current) break;
      const parsed = searchSchema.safeParse(
        await this.#request(
          `${origin}/api/v2/search?q=${encodeURIComponent(current.name)}&from=${current.from}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ types: ["Route"], filter: [], sort: [] }),
          },
        ),
      );
      if (!parsed.success)
        throw new Error(
          "Mountain Project catalogue returned an invalid search response; retry later.",
        );
      const { hits, total } = parsed.data;
      let repeated = false;
      for (const { _source: hit } of hits) {
        if (current.seen.has(hit.id)) {
          repeated = true;
          continue;
        }
        current.seen.add(hit.id);
        if (new URL(hit.url).pathname.split("/")[2] !== hit.id.slice(7))
          throw new Error("Mountain Project catalogue returned inconsistent route identity.");
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (
          [seed.name, ...(seed.aliases ?? [])].some(
            (name) => catalogueNameMatch(name, { name: hit.title }) !== null,
          )
        )
          candidates.push(hitCandidate(hit));
      }
      current.from += hits.length;
      if (repeated) partial = true;
      else if (total.relation === "eq" && current.from >= total.value) continue;
      else if (!hits.length) partial = true;
      else pending.push(current);
    }
    return { candidates, complete: !partial && pending.length === 0 };
  }
}
