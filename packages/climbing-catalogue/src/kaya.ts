import { z } from "zod";
import { cataloguePlainText } from "./area-context.ts";
import type { CatalogueAreaContext, CatalogueLocation } from "./contracts.ts";
import {
  type CatalogueCandidate,
  type CatalogueSearchResult,
  type CatalogueSeed,
  type ClimbingCatalogueAdapter,
  catalogueCandidateSchema,
} from "./contracts.ts";
import { decodeKayaClimbingTags } from "./kaya-tags.ts";
import { catalogueNameMatch, catalogueSearchNames } from "./matching.ts";

const origin = "https://kaya-app.kayaclimb.com";
const endpoint = "https://kaya-beta.kayaclimb.com/graphql";
const named = z.object({ id: z.string().min(1), name: z.string().min(1) });
const coordinate = z.union([
  z.number().finite(),
  z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .transform(Number),
]);
const locationTextFields = [
  ["description", "Description"],
  ["description_bouldering", "Bouldering description"],
  ["description_routes", "Routes description"],
  ["description_short_bouldering", "Bouldering summary"],
  ["description_short_routes", "Routes summary"],
  ["access_description_bouldering", "Bouldering access"],
  ["access_description_routes", "Routes access"],
  ["access_issues_description_bouldering", "Bouldering access issues"],
  ["access_issues_description_routes", "Routes access issues"],
  ["closed_date", "Closed date"],
  ["address", "Address"],
  ["city", "City"],
  ["postal_code", "Postal code"],
  ["region", "Region"],
  ["country", "Country"],
  ["website", "Website"],
] as const;
const locationFlagFields = [
  ["is_closed", "Closed"],
  ["is_access_sensitive", "Access sensitive"],
  ["is_official", "Official"],
] as const;
const location = named.extend({
  slug: z.string().min(1).nullish(),
  location_type: named.nullish(),
  parent_location: named.extend({ slug: z.string().min(1).nullish() }).nullish(),
  description: z.string().nullish(),
  description_bouldering: z.string().nullish(),
  description_routes: z.string().nullish(),
  description_short_bouldering: z.string().nullish(),
  description_short_routes: z.string().nullish(),
  access_description_bouldering: z.string().nullish(),
  access_description_routes: z.string().nullish(),
  access_issues_description_bouldering: z.string().nullish(),
  access_issues_description_routes: z.string().nullish(),
  closed_date: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  postal_code: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  website: z.string().nullish(),
  is_closed: z.boolean().nullish(),
  is_access_sensitive: z.boolean().nullish(),
  is_official: z.boolean().nullish(),
  latitude: coordinate.pipe(z.number().min(-90).max(90)).nullish(),
  longitude: coordinate.pipe(z.number().min(-180).max(180)).nullish(),
});
const climbSchema = z.object({
  id: z.string().regex(/^\d+$/),
  slug: z.string().min(1),
  name: z
    .string()
    .trim()
    .transform((name) => name || null)
    .nullable(),
  climb_type: z.object({ name: z.string() }).nullable(),
  grade: z.object({ name: z.string() }).nullable(),
  gym: location.nullable(),
  board: location.nullable(),
  destination: location.nullable(),
  area: location.nullable(),
  subarea: location.nullable(),
  angle: z.number().finite().nullable(),
});
const searchSchema = z.object({
  data: z.object({ webSearchForClimb: z.array(climbSchema) }),
  errors: z.array(z.unknown()).optional(),
});
// Native Location rejects the public WebLocation short-description fields.
const nativeLocationFields = `id slug name latitude longitude description description_bouldering description_routes access_description_bouldering access_description_routes access_issues_description_bouldering access_issues_description_routes location_type { id name } parent_location { id slug name } is_access_sensitive is_closed closed_date`;
const nativeClimbFields = `id slug name climb_type { name } grade { name } gym { id slug name latitude longitude address city postal_code region country website is_official } board { id name } destination { ${nativeLocationFields} } area { ${nativeLocationFields} } subarea { ${nativeLocationFields} } angle`;
const publicLocationFields = `id slug name latitude longitude description description_bouldering description_routes description_short_bouldering description_short_routes access_description_bouldering access_description_routes access_issues_description_bouldering access_issues_description_routes location_type { id name } parent_location { id slug name } is_access_sensitive is_closed closed_date`;
const publicClimbFields = `id slug name climb_type { name } grade { name } gym { id slug name latitude longitude address city postal_code region country website is_official } board { id name } destination { ${publicLocationFields} } area { ${publicLocationFields} } subarea { ${publicLocationFields} } angle`;
const query = `query CatalogueClimbs($name:String!,$offset:Int!,$count:Int!) { webSearchForClimb(name:$name,offset:$offset,count:$count) { ${publicClimbFields} } }`;
const nativeSchema = z.object({
  data: z.object({
    climb: climbSchema.extend({
      lead: z.boolean().nullable(),
      is_trad: z.boolean().nullable(),
      tags: z.array(
        z.object({
          id: z.union([z.string().min(1), z.number().int()]),
          name: z.string().refine((name) => name.trim().length > 0),
          tag_type_id: z.union([z.string().min(1), z.number().int()]),
        }),
      ),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

type ClassifiedClimb = z.infer<typeof climbSchema> & {
  lead?: boolean | null;
  is_trad?: boolean | null;
  tags?: z.infer<typeof nativeSchema>["data"]["climb"]["tags"];
};

function climbTypeTags(climb: ClassifiedClimb): CatalogueCandidate["tags"] {
  const tags: CatalogueCandidate["tags"] = [];
  if (climb.climb_type?.name.trim())
    tags.push({
      kind: "climb_type",
      sourceKey: "climb_type.name",
      label: climb.climb_type.name,
      category: null,
      scope: "direct",
      inheritedFrom: null,
    });
  const protection =
    climb.is_trad === true
      ? "Trad"
      : climb.lead === true && climb.is_trad === false
        ? "Sport"
        : null;
  if (protection)
    tags.push({
      kind: "climb_type",
      sourceKey: "is_trad",
      label: protection,
      category: null,
      scope: "direct",
      inheritedFrom: null,
    });
  return tags;
}

function catalogueLocation(place: z.infer<typeof location>, gym: boolean): CatalogueLocation {
  const sections: CatalogueAreaContext["sections"] = [];
  for (const [sourceKey, label] of locationTextFields) {
    const text = cataloguePlainText(place[sourceKey]);
    if (text) sections.push({ sourceKey, label, text, inheritedFrom: null });
  }
  for (const [sourceKey, label] of locationFlagFields) {
    const flag = place[sourceKey];
    if (flag != null) sections.push({ sourceKey, label, text: String(flag), inheritedFrom: null });
  }
  return {
    externalId: place.id,
    name: place.name,
    scope: "area",
    coordinates:
      place.latitude != null && place.longitude != null
        ? { latitude: place.latitude, longitude: place.longitude }
        : null,
    ...(place.slug
      ? {
          context: {
            url: `${origin}/${gym ? "gym" : "location"}/${encodeURIComponent(place.slug)}`,
            type: gym ? "Gym" : (place.location_type?.name ?? null),
            sections,
            tags: [],
            statistics: [],
          },
        }
      : {}),
  };
}

function climbLocations(climb: ClassifiedClimb): CatalogueLocation[] {
  const places = [climb.gym, climb.board, climb.destination, climb.area, climb.subarea];
  const explicitIds = new Set(places.flatMap((place) => (place ? [place.id] : [])));
  const result: CatalogueLocation[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    if (!place) continue;
    const parent = place.parent_location;
    if (parent && !explicitIds.has(parent.id) && !seen.has(parent.id)) {
      result.push(catalogueLocation(parent, false));
      seen.add(parent.id);
    }
    if (!seen.has(place.id)) {
      result.push(catalogueLocation(place, place === climb.gym));
      seen.add(place.id);
    }
  }
  return result;
}

function candidate(climb: ClassifiedClimb): CatalogueCandidate {
  const setting = climb.gym || climb.board ? "indoor" : climb.destination ? "outdoor" : null;
  const category =
    setting === "outdoor" && !climb.board
      ? new Map([
          [-20, "slab"],
          [0, "vertical"],
          [20, "overhang"],
          [50, "roof"],
        ]).get(climb.angle ?? Number.NaN)
      : undefined;
  return catalogueCandidateSchema.parse({
    providerId: "kaya",
    externalId: climb.id,
    url: `${origin}/climb/${encodeURIComponent(climb.slug)}`,
    name: climb.name,
    kind:
      climb.climb_type?.name === "Bouldering"
        ? "boulder"
        : climb.climb_type?.name === "Routes"
          ? "route"
          : null,
    setting,
    grade: climb.grade?.name ?? null,
    angle: category || climb.angle === null ? null : { value: climb.angle, unit: null },
    tags: [
      ...climbTypeTags(climb),
      ...decodeKayaClimbingTags(climb).map((tag) => ({
        kind: tag.categoryKey === "3" ? "hold" : "other",
        sourceKey: tag.sourceKey,
        label: tag.label,
        category: tag.categoryLabel ?? tag.categoryKey,
        scope: "direct",
        inheritedFrom: null,
      })),
      ...(category
        ? [
            {
              kind: "steepness",
              sourceKey: "angle",
              label: category,
              category,
              scope: "direct",
              inheritedFrom: null,
            },
          ]
        : []),
    ],
    locations: climbLocations(climb),
  });
}

export class KayaCatalogueAdapter implements ClimbingCatalogueAdapter {
  readonly providerId = "kaya";
  readonly #fetchFn: typeof fetch;
  readonly #getAccessToken: () => Promise<string | null>;
  constructor(fetchFn: typeof fetch, getAccessToken: () => Promise<string | null>) {
    this.#fetchFn = fetchFn;
    this.#getAccessToken = getAccessToken;
  }

  async #request(
    queryText: string,
    variables: Record<string, unknown>,
    token: string | null = null,
  ): Promise<unknown> {
    const response = await this.#fetchFn(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        origin,
        referer: `${origin}/`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query: queryText, variables }),
    });
    if (!response.ok)
      throw new Error(
        `Kaya catalogue request failed (HTTP ${response.status}); ${token ? "sync or reconnect Kaya and retry catalogue enrichment." : "retry catalogue enrichment later."}`,
      );
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== new URL(endpoint).origin)
    )
      throw new Error("Kaya catalogue returned an unexpected redirect.");
    return response.json().then(undefined, (cause: unknown) => {
      throw new Error("Kaya catalogue returned malformed JSON; retry later.", { cause });
    });
  }

  async #native(
    id: string,
    token: string,
    publicClimb?: ClassifiedClimb,
  ): Promise<CatalogueCandidate> {
    const result = nativeSchema.safeParse(
      await this.#request(
        `query CatalogueClimb { climb(id:"${id}") { ${nativeClimbFields} lead is_trad tags { id name tag_type_id } } }`,
        {},
        token,
      ),
    );
    if (!result.success || result.data.errors?.length)
      throw new Error(
        "Kaya authenticated catalogue lookup returned invalid or rejected climb details; sync or reconnect Kaya and retry.",
      );
    if (result.data.data.climb.id !== id)
      throw new Error(
        "Kaya authenticated catalogue lookup returned a different climb ID; retry later.",
      );
    const nativeClimb = result.data.data.climb;
    if (publicClimb) {
      for (const key of ["gym", "board", "destination", "area", "subarea"] as const) {
        const nativePlace = nativeClimb[key];
        const publicPlace = publicClimb[key];
        if (nativePlace && publicPlace?.id === nativePlace.id)
          nativeClimb[key] = { ...publicPlace, ...nativePlace };
      }
    }
    return candidate(nativeClimb);
  }

  async search(seed: CatalogueSeed): Promise<CatalogueSearchResult> {
    if (seed.providerId === this.providerId) {
      if (seed.externalId !== null && !/^\d+$/.test(seed.externalId))
        throw new Error("Kaya catalogue source ID must be numeric.");
      if (seed.sourceUrl) {
        const source = URL.parse(seed.sourceUrl);
        if (
          !source ||
          source.origin !== origin ||
          source.username ||
          source.password ||
          !/^\/climb\/[^/]+$/.test(source.pathname)
        )
          throw new Error("Kaya catalogue source URL must be a Kaya climb URL.");
      }
    }
    const token = await this.#getAccessToken();
    if (token && seed.providerId === this.providerId && seed.externalId)
      return { candidates: [await this.#native(seed.externalId, token)], complete: true };
    const candidates: CatalogueCandidate[] = [];
    const seen = new Set<string>();
    const pending = catalogueSearchNames(seed).map((name) => ({
      name,
      offset: 0,
      seen: new Set<string>(),
    }));
    let partial = false;
    for (let page = 0; page < 3 && pending.length; page++) {
      const current = pending.shift();
      if (!current) break;
      const body = await this.#request(query, {
        name: current.name,
        offset: current.offset,
        count: 20,
      });
      const parsed = searchSchema.safeParse(body);
      if (!parsed.success || parsed.data.errors?.length)
        throw new Error(
          "Kaya catalogue returned an invalid or rejected search response; retry later.",
        );
      const rows = parsed.data.data.webSearchForClimb;
      let repeated = false;
      for (const climb of rows) {
        if (current.seen.has(climb.id)) {
          repeated = true;
          continue;
        }
        current.seen.add(climb.id);
        if (seen.has(climb.id)) continue;
        seen.add(climb.id);
        if (
          [seed.name, ...(seed.aliases ?? [])].some(
            (name) => catalogueNameMatch(name, climb) !== null,
          ) ||
          (seed.providerId === this.providerId && seed.externalId === climb.id)
        )
          candidates.push(token ? await this.#native(climb.id, token, climb) : candidate(climb));
      }
      current.offset += 20;
      if (repeated) partial = true;
      else if (rows.length >= 20) pending.push(current);
    }
    return { candidates, complete: !partial && pending.length === 0 };
  }
}
