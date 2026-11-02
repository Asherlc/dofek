import { z } from "zod";
import { cataloguePlainText } from "./area-context.ts";
import {
  type CatalogueAreaContext,
  type CatalogueCandidate,
  type CatalogueSearchResult,
  type CatalogueSeed,
  type ClimbingCatalogueAdapter,
  catalogueCandidateSchema,
} from "./contracts.ts";
import { gpsCoordinatesSchema } from "./geometry.ts";
import { catalogueNameMatch, catalogueSearchNames } from "./matching.ts";

const origin = "https://www.8a.nu";
const api = "https://vlcapi.vertical-life.info";
const slug = z.string().regex(/^[\p{L}\p{N}_+-]+$/u);
const areaSlugSchema = z
  .string()
  .refine((value) => value.split("/").every((part) => slug.safeParse(part).success), {
    message: "Invalid Vertical-Life area path.",
  });
const id = z.number().int().positive();
const climbSchema = z.object({
  zlaggableName: z.string().trim().min(1),
  zlaggableSlug: slug,
  countrySlug: slug,
  countryName: z.string().min(1),
  areaName: z.string().nullish(),
  areaSlug: areaSlugSchema.nullish(),
  cragName: z.string().min(1),
  cragSlug: slug,
  cragId: id,
  sectorName: z.string().min(1),
  sectorSlug: slug,
  sectorId: id,
  category: z.union([z.literal(0), z.literal(1)]),
  difficulty: z.string().nullable(),
});
const hitSchema = climbSchema.extend({ zlaggableId: id, type: z.literal(3) });
const pageSchema = z.object({ items: z.array(hitSchema) });
const detailSchema = z.object({ zlaggable: climbSchema.extend({ unifiedId: id }) });
const statisticsSchema = z.object({
  totalZlaggables: z.number().int().nonnegative().nullish(),
  totalAscents: z.number().int().nonnegative().nullish(),
  averageRating: z.number().nonnegative().nullish(),
});
const cragSchema = statisticsSchema.extend({
  unifiedId: id,
  cragSlug: slug,
  cragName: z.string().min(1),
  countrySlug: slug,
  areaSlug: areaSlugSchema.nullable(),
  areaName: z.string().min(1).nullable(),
  category: z.union([z.literal(0), z.literal(1)]),
  location: gpsCoordinatesSchema.nullable(),
  description: z.string().nullish(),
  access: z.string().nullish(),
  topFlags: z.array(z.object({ name: z.string().min(1), count: z.number().int().nonnegative() })),
  totalSectors: z.number().int().nonnegative().nullish(),
});
const areaSchema = statisticsSchema.extend({
  unifiedId: id,
  areaSlug: areaSlugSchema,
  areaName: z.string().min(1),
  countrySlug: slug,
  description: z.string().nullish(),
  totalRoutes: z.number().int().nonnegative().nullish(),
  totalBoulders: z.number().int().nonnegative().nullish(),
});
function context(
  url: string,
  record: z.infer<typeof cragSchema> | z.infer<typeof areaSchema>,
): CatalogueAreaContext {
  return {
    url,
    type: null,
    sections: (["description", "access"] as const).flatMap((sourceKey) => {
      const text = cataloguePlainText(
        sourceKey === "description"
          ? record.description
          : "access" in record
            ? record.access
            : null,
      );
      return text
        ? [
            {
              sourceKey,
              label: sourceKey === "description" ? "Description" : "Access",
              text,
              inheritedFrom: null,
            },
          ]
        : [];
    }),
    tags:
      "topFlags" in record
        ? record.topFlags.map(({ name, count }) => ({
            kind: "other",
            sourceKey: name,
            label: name,
            category: "Style",
            scope: "direct",
            inheritedFrom: null,
            count,
          }))
        : [],
    statistics: [
      { sourceKey: "totalZlaggables", label: "Climbs", value: record.totalZlaggables },
      { sourceKey: "totalAscents", label: "Ascents", value: record.totalAscents },
      { sourceKey: "averageRating", label: "Average rating", value: record.averageRating },
      ...("totalSectors" in record
        ? [{ sourceKey: "totalSectors", label: "Sectors", value: record.totalSectors }]
        : []),
      ...("totalRoutes" in record
        ? [{ sourceKey: "totalRoutes", label: "Routes", value: record.totalRoutes }]
        : []),
      ...("totalBoulders" in record
        ? [{ sourceKey: "totalBoulders", label: "Boulders", value: record.totalBoulders }]
        : []),
    ].flatMap(({ sourceKey, label, value }) =>
      typeof value === "number" ? [{ sourceKey, label, value }] : [],
    ),
  };
}
function areaPath(country: string, area: string): string {
  return `/areas/${encodeURIComponent(country)}/${area.split("/").map(encodeURIComponent).join("/")}`;
}
type Climb = z.infer<typeof climbSchema>;

function category(climb: Climb): string {
  return climb.category === 1 ? "bouldering" : "sportclimbing";
}
function routePath(climb: Climb): string {
  return `/crags/${category(climb)}/${encodeURIComponent(climb.countrySlug)}/${encodeURIComponent(climb.cragSlug)}/sectors/${encodeURIComponent(climb.sectorSlug)}/routes/${encodeURIComponent(climb.zlaggableSlug)}`;
}
function validUrlSegment(value: string): boolean {
  try {
    return slug.safeParse(decodeURIComponent(value)).success;
  } catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
}
function candidate(climb: Climb, externalId: number): CatalogueCandidate {
  const area = (externalId: string | null, name: string) => ({
    externalId,
    name,
    scope: "area" as const,
    coordinates: null,
  });
  return catalogueCandidateSchema.parse({
    providerId: "eight-a",
    externalId: String(externalId),
    url: origin + routePath(climb),
    name: climb.zlaggableName,
    kind: climb.category === 1 ? "boulder" : "route",
    setting: "outdoor",
    grade: climb.difficulty,
    angle: null,
    tags: [],
    locations: [
      area(climb.countrySlug, climb.countryName),
      ...(climb.areaName ? [area(climb.areaSlug ?? null, climb.areaName)] : []),
      area(String(climb.cragId), climb.cragName),
      ...(climb.sectorName === "Unknown Sector"
        ? []
        : [area(String(climb.sectorId), climb.sectorName)]),
    ],
  });
}

/** Public Vertical-Life catalogue, using Dofek's existing 8a.nu provider identity. */
export class VerticalLifeCatalogueAdapter implements ClimbingCatalogueAdapter {
  readonly providerId = "eight-a";
  readonly #fetch: typeof fetch;
  constructor(fetchFn: typeof fetch) {
    this.#fetch = fetchFn;
  }

  async #request(path: string): Promise<unknown> {
    const response = await this.#fetch(api + path, { redirect: "error" });
    if (!response.ok)
      throw new Error(
        `Vertical-Life catalogue request failed (HTTP ${response.status}); retry catalogue enrichment later.`,
      );
    if (response.redirected || (response.url && new URL(response.url).origin !== api))
      throw new Error("Vertical-Life catalogue returned an unexpected redirect.");
    return response.json().then(undefined, (cause: unknown) => {
      throw new Error("Vertical-Life catalogue returned malformed JSON; retry later.", { cause });
    });
  }

  async #hydrate(climbs: Map<number, Climb>): Promise<CatalogueCandidate[]> {
    const reads = new Map<string, Promise<unknown>>();
    const read = (path: string) => {
      let result = reads.get(path);
      if (!result) {
        result = this.#request(path);
        reads.set(path, result);
      }
      return result;
    };
    const candidates: CatalogueCandidate[] = [];
    for (const [externalId, climb] of climbs) {
      const cragPath = `/crags/${category(climb)}/${encodeURIComponent(climb.countrySlug)}/${encodeURIComponent(climb.cragSlug)}`;
      const { crag } = z
        .object({ crag: cragSchema })
        .parse(await read(`/outdoor/v1/web${cragPath}`));
      if (
        crag.unifiedId !== climb.cragId ||
        crag.cragSlug !== climb.cragSlug ||
        crag.countrySlug !== climb.countrySlug ||
        crag.category !== climb.category ||
        (climb.areaSlug != null && crag.areaSlug !== climb.areaSlug)
      )
        throw new Error("Vertical-Life catalogue crag identity does not match the climb's parent.");
      let parent: z.infer<typeof areaSchema> | undefined;
      let parentPath: string | undefined;
      if (crag.areaSlug) {
        parentPath = areaPath(crag.countrySlug, crag.areaSlug);
        const { area } = z
          .object({ area: areaSchema })
          .parse(await read(`/collection/v1/web${parentPath}`));
        if (area.countrySlug !== crag.countrySlug || area.areaSlug !== crag.areaSlug)
          throw new Error(
            "Vertical-Life catalogue area identity does not match the crag's parent.",
          );
        parent = area;
      }
      const enriched = candidate(
        { ...climb, areaSlug: crag.areaSlug, areaName: parent?.areaName ?? crag.areaName },
        externalId,
      );
      const cragLocation = enriched.locations[parent || crag.areaName ? 2 : 1];
      if (cragLocation) {
        cragLocation.coordinates = crag.location;
        cragLocation.context = context(origin + cragPath, crag);
      }
      if (parent && parentPath) {
        const location = enriched.locations[1];
        if (location) location.context = context(origin + parentPath, parent);
      }
      candidates.push(catalogueCandidateSchema.parse(enriched));
    }
    return candidates;
  }

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    if (seed.providerId === this.providerId && seed.sourceUrl) {
      const url = URL.parse(seed.sourceUrl);
      if (
        !url ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/crags\/(bouldering|sportclimbing)\/[\p{L}\p{N}_%+-]+\/[\p{L}\p{N}_%+-]+\/sectors\/[\p{L}\p{N}_%+-]+\/routes\/[\p{L}\p{N}_%+-]+$/u.test(
          url.pathname,
        ) ||
        url.pathname.split("/").some((part) => part !== "" && !validUrlSegment(part))
      )
        throw new Error("Vertical-Life catalogue source URL must be an 8a.nu route URL.");
      const { zlaggable } = detailSchema.parse(
        await this.#request(`/outdoor/v1/web${url.pathname}`),
      );
      if (seed.externalId && String(zlaggable.unifiedId) !== seed.externalId)
        throw new Error("Vertical-Life catalogue detail ID does not match the recorded climb.");
      return {
        candidates: await this.#hydrate(new Map([[zlaggable.unifiedId, zlaggable]])),
        complete: true,
      };
    }
    const pending = catalogueSearchNames(seed).map((name) => ({
      name,
      page: 0,
      seen: new Set<number>(),
    }));
    if (!pending.length) return { candidates: [], complete: false };
    const candidates = new Map<number, Climb>();
    let partial = false;
    for (let request = 0; request < 3 && pending.length; request++) {
      const current = pending.shift();
      if (!current) break;
      const params = new URLSearchParams({
        query: current.name,
        pageIndex: String(current.page),
        pageSize: "20",
        "entityTypes[]": "3",
      });
      const { items } = pageSchema.parse(
        await this.#request(`/collection/v1/web/search?${params}`),
      );
      let repeated = false;
      for (const item of items) {
        if (current.seen.has(item.zlaggableId)) {
          repeated = true;
          continue;
        }
        current.seen.add(item.zlaggableId);
        if (
          (seed.providerId === this.providerId && seed.externalId === String(item.zlaggableId)) ||
          seed.references?.some(
            (reference) =>
              reference.providerId === this.providerId &&
              reference.externalId === String(item.zlaggableId),
          ) ||
          [seed.name, ...(seed.aliases ?? [])].some(
            (name) => catalogueNameMatch(name, { name: item.zlaggableName }) !== null,
          )
        )
          candidates.set(item.zlaggableId, item);
      }
      current.page++;
      if (repeated) partial = true;
      else if (items.length >= 20) pending.push(current);
    }
    return {
      candidates: await this.#hydrate(candidates),
      complete: !partial && pending.length === 0,
    };
  }
}
