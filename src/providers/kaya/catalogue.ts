import {
  type CatalogueCandidate,
  type CatalogueSearchResult,
  type CatalogueSeed,
  type ClimbingCatalogueAdapter,
  catalogueCandidateSchema,
} from "@dofek/training/climbing-catalogue";
import { z } from "zod";
import { decodeKayaClimbingTags } from "./climbing-tags.ts";

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
const location = named.extend({
  latitude: coordinate.pipe(z.number().min(-90).max(90)).nullish(),
  longitude: coordinate.pipe(z.number().min(-180).max(180)).nullish(),
});
const climbSchema = z.object({
  id: z.string().regex(/^\d+$/),
  slug: z.string().min(1),
  name: z.string().min(1),
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
const climbFields = `id slug name climb_type { name } grade { name } gym { id name } board { id name } destination { id name latitude longitude } area { id name latitude longitude } subarea { id name latitude longitude } angle`;
const query = `query CatalogueClimbs($name:String!,$offset:Int!,$count:Int!) { webSearchForClimb(name:$name,offset:$offset,count:$count) { ${climbFields} } }`;
const nativeSchema = z.object({
  data: z.object({
    climb: climbSchema.extend({
      lead: z.boolean().nullable(),
      is_trad: z.boolean().nullable(),
      tags: z.array(
        z.object({
          id: z.union([z.string().min(1), z.number().int()]),
          name: z.string().trim().min(1),
          tag_type_id: z.union([z.string().min(1), z.number().int()]),
        }),
      ),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const normalize = (name: string) =>
  name.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

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
    locations: [climb.gym, climb.board, climb.destination, climb.area, climb.subarea].flatMap(
      (place) =>
        place
          ? [
              {
                externalId: place.id,
                name: place.name,
                scope: "area",
                coordinates:
                  "latitude" in place && place.latitude != null && place.longitude != null
                    ? { latitude: place.latitude, longitude: place.longitude }
                    : null,
              },
            ]
          : [],
    ),
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

  async #native(id: string, token: string): Promise<CatalogueCandidate> {
    const result = nativeSchema.safeParse(
      await this.#request(
        `query CatalogueClimb { climb(id:"${id}") { ${climbFields} lead is_trad tags { id name tag_type_id } } }`,
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
    return candidate(result.data.data.climb);
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
    for (let page = 0; page < 3; page++) {
      const body = await this.#request(query, { name: seed.name, offset: page * 20, count: 20 });
      const parsed = searchSchema.safeParse(body);
      if (!parsed.success || parsed.data.errors?.length)
        throw new Error(
          "Kaya catalogue returned an invalid or rejected search response; retry later.",
        );
      const rows = parsed.data.data.webSearchForClimb;
      let repeated = false;
      for (const climb of rows) {
        if (seen.has(climb.id)) {
          repeated = true;
          continue;
        }
        seen.add(climb.id);
        if (
          normalize(climb.name) === normalize(seed.name) ||
          (seed.providerId === this.providerId && seed.externalId === climb.id)
        )
          candidates.push(token ? await this.#native(climb.id, token) : candidate(climb));
      }
      if (repeated) return { candidates, complete: false };
      if (rows.length < 20) return { candidates, complete: true };
    }
    return { candidates, complete: false };
  }
}
