import type {
  CatalogueCandidate,
  CatalogueSearchResult,
  CatalogueSeed,
  ClimbingCatalogueAdapter,
} from "@dofek/training/climbing-catalogue";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";

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
const climbSchema = z.object({
  uuid,
  name: z.string().trim().min(1),
  type: z.record(z.string(), z.boolean().nullable()),
  grades: z.record(z.string(), z.string().nullable()).nullable(),
  metadata,
  parent: z.object({ uuid, area_name: z.string().trim().min(1), metadata }),
  pathTokens: z.array(z.string().min(1)).nullish(),
  ancestors: z.array(uuid).nullish(),
});
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
    metadata { lat lng } parent { uuid area_name metadata { lat lng } }
    pathTokens ancestors
  }
}`;

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function coordinates(value: z.infer<typeof metadata>) {
  return value.lat == null || value.lng == null
    ? null
    : { latitude: value.lat, longitude: value.lng };
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
    return response.json().catch((cause: unknown) => {
      const error = new Error(
        "OpenBeta catalogue returned invalid JSON. Retry when public access is available.",
        { cause },
      );
      captureException(error, { tags: { provider: "openbeta", phase: "catalogue" } });
      throw error;
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

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    const id = sourceId(seed);
    if (id) return { candidates: [await this.#climb(id)], complete: false };
    const ids = new Set<string>();
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(SEARCH);
      url.search = new URLSearchParams({
        q: seed.name,
        query_by: "climbName",
        per_page: String(PAGE_SIZE),
        page: String(page),
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
      if (result.page !== page) break;
      for (const hit of result.hits)
        if (normalize(hit.document.climbName) === normalize(seed.name))
          ids.add(hit.document.climbUUID);
      if (result.search_cutoff || result.found <= page * PAGE_SIZE) {
        complete = !result.search_cutoff;
        break;
      }
    }
    const candidates: CatalogueCandidate[] = [];
    for (const id of ids) candidates.push(await this.#climb(id));
    return { candidates, complete };
  }
}
