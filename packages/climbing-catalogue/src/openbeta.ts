import { z } from "zod";
import { cataloguePlainText } from "./area-context.ts";
import type {
  CatalogueCandidate,
  CatalogueLocation,
  CatalogueSearchResult,
  CatalogueSeed,
  ClimbingCatalogueAdapter,
} from "./contracts.ts";
import {
  CATALOGUE_LOCAL_AREA_METRES,
  catalogueAreasAreNearby,
  catalogueLocalArea,
  catalogueNameMatch,
  catalogueSearchNames,
  normalizeCatalogueName,
} from "./matching.ts";

const API = "https://api.openbeta.io";
const SEARCH = "https://typesense-01.openbeta.io/collections/climbs/documents/search";
// Published browser search-only credential, not an account or administrative key.
// https://github.com/OpenBeta/open-tacos/blob/develop/.env
const PUBLIC_SEARCH_KEY = "bCGIB4sHsJRy06NFjZLtxKIMgr4aO0tX";
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const uuid = z.uuid();
const metadata = z.object({
  lat: z.number().finite().min(-90).max(90).nullish(),
  lng: z.number().finite().min(-180).max(180).nullish(),
  mp_id: z.string().regex(/^\d+$/).nullish(),
});
const labels = new Map([
  ["trad", ["Trad", "trad"]],
  ["sport", ["Sport", "sport"]],
  ["bouldering", ["Bouldering", "boulder"]],
  ["deepwatersolo", ["Deep water solo", "deep_water_solo"]],
  ["alpine", ["Alpine", "alpine"]],
  ["snow", ["Snow", "snow"]],
  ["ice", ["Ice", "ice"]],
  ["mixed", ["Mixed", "mixed"]],
  ["aid", ["Aid", "aid"]],
  ["tr", ["Top rope", "top_rope"]],
]);
const climbFacts = z.object({
  uuid,
  name: z.string().trim().min(1),
  type: z.record(z.string(), z.boolean().nullable()),
  grades: z.record(z.string(), z.string().nullable()).nullable(),
  metadata,
});
const climbSchema = climbFacts.extend({
  parent: z.object({ uuid, area_name: z.string().trim().min(1), metadata }),
  pathTokens: z.array(z.string().min(1)).nullish(),
  ancestors: z.array(uuid).nullish(),
});
const areaSchema = z.object({
  uuid,
  area_name: z.string().trim().min(1),
  metadata: metadata.extend({ leaf: z.boolean().nullish() }),
  pathTokens: z.array(z.string().min(1)).nullish(),
  ancestors: z.array(uuid).nullish(),
});
const areaSummarySchema = areaSchema.extend({ totalClimbs: z.number().int().nonnegative() });
const contextAreaSchema = areaSummarySchema.extend({
  content: z
    .object({ description: z.string().nullish(), areaLocation: z.string().nullish() })
    .nullish(),
  aggregate: z
    .object({
      byGrade: z
        .array(z.object({ label: z.string().min(1), count: z.number().int().nonnegative() }))
        .nullish(),
      byDiscipline: z
        .record(z.string(), z.object({ total: z.number().int().nonnegative() }).nullable())
        .nullish(),
      byGradeBand: z.record(z.string(), z.number().int().nonnegative()).nullish(),
    })
    .nullish(),
});
const contextFields = `content { description areaLocation } aggregate { byGrade { label count } byDiscipline { trad { total } sport { total } bouldering { total } tr { total } } byGradeBand { unknown beginner intermediate advanced expert } }`;
const hydratedAreaSchema = contextAreaSchema.extend({ climbs: z.array(z.unknown()) });
const areaFields =
  "uuid area_name pathTokens ancestors totalClimbs metadata { lat lng mp_id leaf }";
const climbFields = `uuid name type { trad sport bouldering deepwatersolo alpine snow ice mixed aid tr }
    grades { yds vscale french font ewbank uiaa brazilianCrux wi } metadata { lat lng mp_id }`;
const nearbyQuery = `query NearbyCatalogueAreas($bbox:[Float],$zoom:Float) { cragsWithin(filter:{bbox:$bbox,zoom:$zoom}) { uuid area_name pathTokens ancestors metadata { lat lng mp_id leaf } } }`;
const searchSchema = z.object({
  found: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  search_cutoff: z.boolean(),
  hits: z.array(
    z.object({ document: z.object({ climbUUID: uuid, climbName: z.string().min(1) }) }),
  ),
});
const query = `query CatalogueClimb($uuid: ID!) {
  climb(uuid: $uuid) {
    uuid name type { trad sport bouldering deepwatersolo alpine snow ice mixed aid tr }
    grades { yds vscale french font ewbank uiaa brazilianCrux wi }
    metadata { lat lng mp_id } parent { uuid area_name metadata { lat lng mp_id } }
    pathTokens ancestors
  }
}`;

function coordinates(value: z.infer<typeof metadata>) {
  return value.lat == null || value.lng == null
    ? null
    : { latitude: value.lat, longitude: value.lng };
}

function areaLocation(area: z.infer<typeof areaSchema>): CatalogueLocation {
  return {
    externalId: area.uuid,
    name: area.area_name,
    scope: "area",
    coordinates: coordinates(area.metadata),
  };
}

function contextLocation(area: z.infer<typeof contextAreaSchema>): CatalogueLocation {
  const sections: NonNullable<CatalogueLocation["context"]>["sections"] = [];
  for (const [key, label] of [
    ["description", "Description"],
    ["areaLocation", "Location"],
  ] as const) {
    const text = cataloguePlainText(area.content?.[key]);
    if (text) sections.push({ sourceKey: `content.${key}`, label, text, inheritedFrom: null });
  }
  const statistics = [{ sourceKey: "totalClimbs", label: "Total climbs", value: area.totalClimbs }];
  for (const grade of area.aggregate?.byGrade ?? [])
    statistics.push({
      sourceKey: `aggregate.byGrade.${grade.label}`,
      label: grade.label,
      value: grade.count,
    });
  for (const [key, count] of Object.entries(area.aggregate?.byDiscipline ?? {})) {
    if (count)
      statistics.push({
        sourceKey: `aggregate.byDiscipline.${key}`,
        label: labels.get(key)?.[0] ?? key,
        value: count.total,
      });
  }
  for (const [key, value] of Object.entries(area.aggregate?.byGradeBand ?? {}))
    statistics.push({ sourceKey: `aggregate.byGradeBand.${key}`, label: key, value });
  return {
    ...areaLocation(area),
    context: {
      url: `https://openbeta.io/area/${area.uuid}`,
      type: null,
      sections,
      tags: [],
      statistics,
    },
  };
}

function matchesArea(
  seed: CatalogueSeed,
  local: CatalogueLocation,
  area: z.infer<typeof areaSchema>,
): boolean {
  if (local.externalId && seed.providerId === "openbeta") return local.externalId === area.uuid;
  if (local.externalId && seed.providerId === "mountain-project" && area.metadata.mp_id)
    return local.externalId === area.metadata.mp_id;
  return (
    normalizeCatalogueName(local.name ?? "") === normalizeCatalogueName(area.area_name) &&
    catalogueAreasAreNearby(local, areaLocation(area))
  );
}

function sourceId(seed: CatalogueSeed): string | null {
  if (seed.providerId !== "openbeta") return null;
  let id = seed.externalId;
  if (id && !uuid.safeParse(id).success)
    throw new Error("OpenBeta catalogue climb UUID is invalid. Check the recorded source climb.");
  if (seed.sourceUrl) {
    const url = URL.canParse(seed.sourceUrl) ? new URL(seed.sourceUrl) : null;
    const match = url && /^\/climb\/([^/]+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
    if (
      url?.origin !== "https://openbeta.io" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      !uuid.safeParse(match[1]).success
    )
      throw new Error("OpenBeta catalogue source URL is invalid. Use a public OpenBeta climb URL.");
    if (id && id !== match[1])
      throw new Error(
        "OpenBeta catalogue source identity conflicts with its UUID. Check the recorded source climb.",
      );
    id = match[1] ?? null;
  }
  return id;
}

function candidate(climb: z.infer<typeof climbSchema>): CatalogueCandidate {
  const tags: CatalogueCandidate["tags"] = [];
  for (const [key, value] of Object.entries(climb.type)) {
    if (value !== true) continue;
    const classification = labels.get(key);
    tags.push({
      kind: "climb_type",
      sourceKey: key,
      label: classification?.[0] ?? key,
      category: classification?.[1] ?? null,
      scope: "direct",
      inheritedFrom: null,
    });
  }
  const boulder = climb.type.bouldering === true;
  const route = tags.some((tag) => tag.sourceKey !== "bouldering" && labels.has(tag.sourceKey));
  const locations: CatalogueCandidate["locations"] = [
    {
      externalId: climb.uuid,
      name: climb.name,
      scope: "climb",
      coordinates: coordinates(climb.metadata),
    },
  ];
  const names = climb.pathTokens ?? [];
  const ancestors = climb.ancestors ?? [];
  if (
    ancestors.length &&
    (names.length !== ancestors.length || ancestors.at(-1) !== climb.parent.uuid)
  )
    throw new Error("OpenBeta catalogue area ancestry is invalid. Retry or contact support.");
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name) continue;
    const parent = i === names.length - 1;
    locations.push({
      externalId: ancestors[i] ?? (parent ? climb.parent.uuid : null),
      name,
      scope: "area",
      coordinates: parent ? coordinates(climb.parent.metadata) : null,
    });
  }
  if (!names.length)
    locations.push({
      externalId: climb.parent.uuid,
      name: climb.parent.area_name,
      scope: "area",
      coordinates: coordinates(climb.parent.metadata),
    });
  const grades = climb.grades;
  return {
    providerId: "openbeta",
    externalId: climb.uuid,
    url: `https://openbeta.io/climb/${climb.uuid}`,
    name: climb.name,
    ...(climb.metadata.mp_id
      ? {
          references: [
            { providerId: "mountain-project" as const, externalId: climb.metadata.mp_id },
          ],
        }
      : {}),
    kind: boulder === route ? null : boulder ? "boulder" : "route",
    setting: null,
    locations,
    grade:
      (boulder ? (grades?.vscale ?? grades?.font) : grades?.yds) ??
      Object.values(grades ?? {}).find((grade) => grade?.trim()) ??
      null,
    angle: null,
    tags,
  };
}

/** Public catalogue metadata only; no account, tick or durable catalogue writes. */
export class OpenBetaCatalogueAdapter implements ClimbingCatalogueAdapter {
  readonly providerId = "openbeta" as const;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  async #request(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetchFn(url, { ...init, redirect: "manual" });
    if (!response.ok)
      throw new Error(
        `OpenBeta catalogue request failed (HTTP ${response.status}). Retry when public access is available.`,
      );
    if (response.url && response.url !== new URL(url).href)
      throw new Error(
        "OpenBeta catalogue response URL is invalid. Retry when public access is available.",
      );
    return response.json().then(undefined, (cause: unknown) => {
      throw new Error(
        "OpenBeta catalogue returned invalid JSON. Retry when public access is available.",
        { cause },
      );
    });
  }

  async #climb(id: string): Promise<CatalogueCandidate> {
    const response = await this.#request(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { uuid: id } }),
    });
    const envelope = z
      .object({
        errors: z.array(z.unknown()).optional(),
        data: z.object({ climb: climbSchema.nullable() }).optional(),
      })
      .safeParse(response);
    if (!envelope.success || envelope.data.errors?.length || !envelope.data.data?.climb)
      throw new Error(
        "OpenBeta catalogue climb is unavailable or invalid. Check the source URL or retry later.",
      );
    const climb = envelope.data.data.climb;
    if (climb.uuid !== id)
      throw new Error(
        "OpenBeta catalogue response identity does not match the requested climb. Check its source URL.",
      );
    return candidate(climb);
  }

  async #graph(queryText: string, variables: Record<string, unknown>): Promise<unknown> {
    return this.#request(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: queryText, variables }),
    });
  }

  async #local(
    seed: CatalogueSeed,
    local: CatalogueLocation & { coordinates: NonNullable<CatalogueLocation["coordinates"]> },
    cache: Map<string, z.infer<typeof contextAreaSchema>>,
  ): Promise<CatalogueSearchResult> {
    const { latitude, longitude } = local.coordinates;
    const degrees = (CATALOGUE_LOCAL_AREA_METRES / 6_371_000) * (180 / Math.PI);
    const longitudeDegrees = degrees / Math.cos((latitude * Math.PI) / 180);
    const discovered = z
      .object({
        errors: z.array(z.unknown()).optional(),
        data: z.object({ cragsWithin: z.array(areaSchema) }),
      })
      .safeParse(
        await this.#graph(nearbyQuery, {
          bbox: [
            Math.max(-180, longitude - longitudeDegrees),
            Math.max(-90, latitude - degrees),
            Math.min(180, longitude + longitudeDegrees),
            Math.min(90, latitude + degrees),
          ],
          zoom: 15,
        }),
      );
    if (!discovered.success || discovered.data.errors?.length)
      throw new Error(
        "OpenBeta catalogue local-area discovery is invalid. Retry when public access is available.",
      );
    const areas = [
      ...new Map(
        discovered.data.data.cragsWithin
          .filter((area) => matchesArea(seed, local, area))
          .map((area) => [area.uuid, area]),
      ).values(),
    ];
    const candidates = new Map<string, CatalogueCandidate>();
    let hydratedClimbs = 0;
    let complete = areas.length > 0 && areas.length <= 3;
    let searchArea: CatalogueLocation = local;
    for (const selected of areas.slice(0, 3)) {
      if (hydratedClimbs >= 200) {
        complete = false;
        break;
      }
      const summary = z
        .object({
          errors: z.array(z.unknown()).optional(),
          data: z.object({ area: contextAreaSchema.nullable() }),
        })
        .safeParse(
          await this.#graph(
            `query CatalogueArea($uuid:ID) { area(uuid:$uuid) { ${areaFields} ${contextFields} } }`,
            { uuid: selected.uuid },
          ),
        );
      if (!summary.success || summary.data.errors?.length || !summary.data.data.area)
        throw new Error("OpenBeta catalogue area metadata is unavailable or invalid. Retry later.");
      const area = summary.data.data.area;
      cache.set(area.uuid, area);
      if (area.uuid !== selected.uuid || !matchesArea(seed, local, area))
        throw new Error(
          "OpenBeta catalogue area identity does not match the selected local area. Retry later.",
        );
      if (areas.length === 1) searchArea = areaLocation(area);
      if (area.metadata.leaf !== true || area.totalClimbs > 200 - hydratedClimbs) {
        complete = false;
        continue;
      }
      const hydrated = z
        .object({
          errors: z.array(z.unknown()).optional(),
          data: z.object({ area: hydratedAreaSchema.nullable() }),
        })
        .safeParse(
          await this.#graph(
            `query CatalogueArea($uuid:ID) { area(uuid:$uuid) { ${areaFields} ${contextFields} climbs { ${climbFields} } } }`,
            { uuid: area.uuid },
          ),
        );
      if (!hydrated.success || hydrated.data.errors?.length || !hydrated.data.data.area)
        throw new Error("OpenBeta catalogue area climbs are unavailable or invalid. Retry later.");
      const full = hydrated.data.data.area;
      const remaining = 200 - hydratedClimbs;
      if (full.climbs.length > remaining) complete = false;
      const retained = z.array(climbFacts).safeParse(full.climbs.slice(0, remaining));
      if (!retained.success)
        throw new Error("OpenBeta catalogue area climbs are unavailable or invalid. Retry later.");
      hydratedClimbs += retained.data.length;
      if (full.uuid !== area.uuid || !matchesArea(seed, local, full))
        throw new Error(
          "OpenBeta catalogue area identity does not match the selected local area. Retry later.",
        );
      const unique = new Map(retained.data.map((climb) => [climb.uuid, climb]));
      if (
        unique.size !== full.totalClimbs ||
        full.totalClimbs !== area.totalClimbs ||
        full.metadata.leaf !== true
      )
        complete = false;
      for (const climb of unique.values()) {
        if (candidates.size >= 200) {
          complete = false;
          break;
        }
        candidates.set(
          climb.uuid,
          candidate({
            ...climb,
            parent: full,
            pathTokens: full.pathTokens,
            ancestors: full.ancestors,
          }),
        );
      }
    }
    return { candidates: [...candidates.values()], complete, searchArea };
  }

  async #context(
    result: CatalogueSearchResult,
    cache: Map<string, z.infer<typeof contextAreaSchema>>,
  ): Promise<CatalogueSearchResult> {
    for (const candidate of result.candidates) {
      const local = candidate.locations.filter((location) => location.scope === "area").at(-1);
      if (!local?.externalId) continue;
      const area = await this.#area(local.externalId, cache);
      const names = area.pathTokens ?? [];
      const ancestors = area.ancestors ?? [];
      if (ancestors.length && (ancestors.length !== names.length || ancestors.at(-1) !== area.uuid))
        throw new Error("OpenBeta catalogue area ancestry is invalid. Retry or contact support.");
      const parentId = ancestors.at(-2);
      const parent = parentId && parentId !== area.uuid ? await this.#area(parentId, cache) : null;
      if (ancestors.length) {
        const climbLocations = candidate.locations.filter((location) => location.scope === "climb");
        candidate.locations = [
          ...climbLocations,
          ...ancestors.map((id, index): CatalogueLocation => {
            if (id === area.uuid) return contextLocation(area);
            if (parent && id === parent.uuid) return contextLocation(parent);
            return { externalId: id, name: names[index] ?? null, scope: "area", coordinates: null };
          }),
        ];
      } else {
        const index = candidate.locations.indexOf(local);
        candidate.locations[index] = contextLocation(area);
      }
    }
    return result;
  }

  async #area(
    id: string,
    cache: Map<string, z.infer<typeof contextAreaSchema>>,
  ): Promise<z.infer<typeof contextAreaSchema>> {
    const cached = cache.get(id);
    if (cached) return cached;
    const result = z
      .object({
        errors: z.array(z.unknown()).optional(),
        data: z.object({ area: contextAreaSchema.nullable() }).optional(),
      })
      .safeParse(
        await this.#graph(
          `query CatalogueParentContext($uuid:ID!) { area(uuid:$uuid) { ${areaFields} ${contextFields} } }`,
          { uuid: id },
        ),
      );
    if (
      !result.success ||
      result.data.errors?.length ||
      !result.data.data?.area ||
      result.data.data.area.uuid !== id
    )
      throw new Error(
        "OpenBeta catalogue parent area is unavailable or invalid. Check the source area or retry later.",
      );
    cache.set(id, result.data.data.area);
    return result.data.data.area;
  }

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    const cache = new Map<string, z.infer<typeof contextAreaSchema>>();
    const id = sourceId(seed);
    if (id) return this.#context({ candidates: [await this.#climb(id)], complete: false }, cache);
    const local = catalogueLocalArea(seed.locations);
    const areaResult = local?.coordinates
      ? await this.#local(seed, { ...local, coordinates: local.coordinates }, cache)
      : null;
    if (areaResult?.complete) return this.#context(areaResult, cache);
    const candidates = new Map(
      areaResult?.candidates.map((candidate) => [candidate.externalId, candidate]),
    );
    const ids = new Set<string>();
    const pending = catalogueSearchNames(seed).map((name) => ({
      name,
      page: 1,
      seen: new Set<string>(),
    }));
    let partial = false;
    for (let request = 0; request < MAX_PAGES && pending.length; request++) {
      const current = pending.shift();
      if (!current) break;
      const url = new URL(SEARCH);
      url.search = new URLSearchParams({
        q: current.name,
        query_by: "climbName",
        per_page: String(PAGE_SIZE),
        page: String(current.page),
      }).toString();
      const response = searchSchema.safeParse(
        await this.#request(url.href, {
          method: "GET",
          headers: { "X-TYPESENSE-API-KEY": PUBLIC_SEARCH_KEY },
        }),
      );
      if (!response.success)
        throw new Error(
          "OpenBeta catalogue search response is invalid. Retry when public access is available.",
        );
      const result = response.data;
      if (result.page !== current.page) {
        partial = true;
        continue;
      }
      let repeated = false;
      for (const hit of result.hits) {
        if (current.seen.has(hit.document.climbUUID)) repeated = true;
        current.seen.add(hit.document.climbUUID);
        if (
          [seed.name, ...(seed.aliases ?? [])].some(
            (name) => catalogueNameMatch(name, { name: hit.document.climbName }) !== null,
          )
        )
          ids.add(hit.document.climbUUID);
      }
      if (result.search_cutoff || repeated) partial = true;
      else if (current.seen.size >= result.found) continue;
      else if (result.hits.length < PAGE_SIZE) partial = true;
      else {
        current.page++;
        pending.push(current);
      }
    }
    for (const id of ids) {
      if (!candidates.has(id)) candidates.set(id, await this.#climb(id));
    }
    return this.#context(
      {
        candidates: [...candidates.values()],
        complete: areaResult === null && !partial && pending.length === 0,
      },
      cache,
    );
  }
}
