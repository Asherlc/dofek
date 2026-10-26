import { isValidClimbingGrade } from "@dofek/training/climbing-grades";
import type { ClimbKind, GradeComponent, RopeMethod } from "@dofek/training/climbing-log";
import { gpsCoordinatesSchema } from "@dofek/training/gps-coordinates";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import { persistClimbingLogSnapshot } from "../db/climbing-log-snapshot.ts";
import {
  persistClimbingLogEntries,
  type SourceAreaDefinition,
  type SourceClimbingAttempt,
  type SourceClimbingLogEntry,
} from "../db/climbing-log-sync.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { findProviderTransportError } from "../lib/provider-transport-error.ts";
import { type FetchProviderPagesResult, fetchProviderPages } from "../sync/pagination.ts";
import { ProviderAuthError, ProviderStoredIdentityMissingError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

const OPENBETA_API_BASE_URL = "https://api.openbeta.io";
const OPENBETA_PROVIDER_ID = "openbeta";
const OPENBETA_PROVIDER_NAME = "OpenBeta";
const OPENBETA_PAGE_SIZE = 100;

const OPENBETA_USER_PAGE_QUERY = `
  query OpenBetaUserPage($username: String!) {
    userPage(input: { username: $username }) {
      profile {
        userUuid
        username
        displayName
      }
    }
  }
`;

const OPENBETA_TICKS_QUERY = `
  query OpenBetaUserTicks($userId: MUUID!, $limit: Int!, $offset: Int!) {
    userTicks(userId: $userId, limit: $limit, offset: $offset) {
      _id
      userId
      name
      notes
      climbId
      style
      attemptType
      dateClimbed
      grade
      source
      user {
        username
        displayName
      }
      climb {
        uuid
        name
        pathTokens
        ancestors
        metadata { lat lng }
        grades {
          vscale
          yds
          ewbank
          french
          font
          uiaa
          brazilianCrux
          wi
        }
        pitches {
          id
          parentId
          pitchNumber
          grades { vscale yds ewbank french font uiaa brazilianCrux wi }
        }
        type {
          bouldering
          sport
          trad
        }
        parent {
          uuid
          area_name
          metadata { lat lng }
        }
      }
    }
  }
`;

const graphQLErrorSchema = z.object({ message: z.string() }).passthrough();
const graphQLResponseSchema = z
  .object({
    data: z.unknown().nullable().optional(),
    errors: z.array(graphQLErrorSchema).optional(),
  })
  .passthrough();

const openBetaProfileSchema = z.object({
  userUuid: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().nullable(),
});

const coordinateMetadataSchema = z.object({ lat: z.number().nullish(), lng: z.number().nullish() });
const openBetaGradesSchema = z.object({
  vscale: z.string().nullable(),
  yds: z.string().nullable(),
  ewbank: z.string().nullable(),
  french: z.string().nullable(),
  font: z.string().nullable(),
  uiaa: z.string().nullable(),
  brazilianCrux: z.string().nullable(),
  wi: z.string().nullish(),
});
const openBetaPitchSchema = z.object({
  id: z.string().trim().min(1),
  parentId: z.string().trim().min(1),
  pitchNumber: z.number().int(),
  grades: openBetaGradesSchema.nullable(),
});

const openBetaTickSchema = z
  .object({
    _id: z.string().min(1),
    userId: z.string().nullable(),
    name: z.string().nullable(),
    notes: z.string().nullable(),
    climbId: z.string().nullable(),
    style: z.enum(["Lead", "Solo", "TR", "Follow", "Aid", "Boulder"]).nullable(),
    attemptType: z
      .string()
      .refine((value) => value.trim().length > 0)
      .nullable(),
    dateClimbed: z.number().int().nullable(),
    grade: z.string().nullable(),
    source: z.enum(["OB", "MP"]).nullable(),
    user: z
      .object({
        username: z.string().nullable(),
        displayName: z.string().nullable(),
      })
      .nullable(),
    climb: z
      .object({
        uuid: z.string().nullable(),
        name: z.string().nullable(),
        pathTokens: z.array(z.string().trim().min(1)).nullish(),
        ancestors: z.array(z.string().trim().min(1)).nullish(),
        metadata: coordinateMetadataSchema.nullish(),
        grades: openBetaGradesSchema.nullable(),
        pitches: z.array(openBetaPitchSchema.nullable()).nullish(),
        type: z
          .object({
            bouldering: z.boolean().nullable(),
            sport: z.boolean().nullable(),
            trad: z.boolean().nullable(),
          })
          .nullable(),
        parent: z
          .object({
            uuid: z.string().trim().min(1).nullish(),
            area_name: z.string().nullable(),
            metadata: coordinateMetadataSchema.nullish(),
          })
          .nullable(),
      })
      .nullable(),
  })
  .catchall(z.json());

const openBetaUserPageResponseSchema = z.object({
  userPage: z.object({ profile: openBetaProfileSchema.nullable() }).nullable(),
});

const openBetaTicksResponseSchema = z.object({
  userTicks: z.array(openBetaTickSchema),
});

type OpenBetaTick = z.infer<typeof openBetaTickSchema>;
type OpenBetaGradeSystem =
  | "v_scale"
  | "font"
  | "yds"
  | "french"
  | "uiaa"
  | "ewbank"
  | "brazilian_crux"
  | "water_ice";

interface OpenBetaTickParseResult {
  entries: SourceClimbingLogEntry[];
  errors: SyncError[];
}

interface GraphQLVariables {
  [key: string]: string | number;
}

async function fetchGraphQL<T>(
  fetchFn: typeof globalThis.fetch,
  query: string,
  variables: GraphQLVariables,
  dataSchema: z.ZodType<T>,
): Promise<T> {
  const response = await fetchFn(OPENBETA_API_BASE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`OpenBeta API request failed (${response.status}).`);
  }

  const body: unknown = await response.json();
  const envelope = graphQLResponseSchema.parse(body);
  if (envelope.errors && envelope.errors.length > 0) {
    throw new Error(`OpenBeta API returned an error: ${envelope.errors[0]?.message}`);
  }
  if (envelope.data == null) {
    throw new Error("OpenBeta API returned no data.");
  }
  return dataSchema.parse(envelope.data);
}

function profileConnectionError(options?: ErrorOptions): ProviderAuthError {
  return new ProviderAuthError(
    "authentication_failed",
    "Paste a public OpenBeta profile URL or username, and make sure the profile is public.",
    options,
  );
}

function parseOpenBetaUsername(input: string): string {
  const value = input.trim();
  if (!value) throw profileConnectionError();

  let username = value;
  if (value.includes("/")) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch (error) {
      throw profileConnectionError({ cause: error });
    }

    if (!["openbeta.io", "www.openbeta.io"].includes(url.hostname.toLowerCase())) {
      throw profileConnectionError();
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      segments.length < 2 ||
      segments[0] !== "u" ||
      (segments.length > 2 && !(segments.length === 3 && segments[2] === "ticks"))
    ) {
      throw profileConnectionError();
    }
    try {
      username = decodeURIComponent(segments[1] ?? "");
    } catch (error) {
      throw profileConnectionError({ cause: error });
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(username)) {
    throw profileConnectionError();
  }
  return username;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseOpenBetaDate(value: number | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  const year = parsed.getUTCFullYear();
  return Number.isNaN(parsed.getTime()) || year < 1 || year > 9999
    ? null
    : parsed.toISOString().slice(0, 10);
}

function publishedGrades(
  grades: z.infer<typeof openBetaGradesSchema> | null | undefined,
): GradeComponent[] {
  const fields: readonly [keyof z.infer<typeof openBetaGradesSchema>, OpenBetaGradeSystem][] = [
    ["vscale", "v_scale"],
    ["font", "font"],
    ["yds", "yds"],
    ["french", "french"],
    ["uiaa", "uiaa"],
    ["ewbank", "ewbank"],
    ["brazilianCrux", "brazilian_crux"],
    ["wi", "water_ice"],
  ];
  return fields.flatMap(([field, system]) => {
    const value = nullableText(grades?.[field]);
    return value ? [{ value, system: isValidClimbingGrade(value, system) ? system : null }] : [];
  });
}

function reportedGrades(value: string | null, kind: ClimbKind | null): GradeComponent[] {
  const grade = nullableText(value);
  if (!grade) return [];
  const candidates: readonly OpenBetaGradeSystem[] =
    kind === "boulder" ? ["v_scale", "font"] : ["yds", "french"];
  return [
    {
      value: grade,
      system: candidates.find((system) => isValidClimbingGrade(grade, system)) ?? null,
    },
  ];
}

function sourceCoordinates(metadata: z.infer<typeof coordinateMetadataSchema> | null | undefined) {
  if (metadata?.lat == null || metadata.lng == null) return undefined;
  return gpsCoordinatesSchema.parse({ latitude: metadata.lat, longitude: metadata.lng });
}

function locationPathForTick(tick: OpenBetaTick): SourceAreaDefinition[] {
  const climb = tick.climb;
  if (!climb) return [];
  if (tick.climbId != null && climb.uuid != null && tick.climbId.trim() !== climb.uuid.trim())
    throw new Error(
      `OpenBeta tick ${tick._id} has inconsistent climb identity. Re-sync after the source reference is corrected.`,
    );
  const names = climb.pathTokens;
  const ids = climb.ancestors;
  const parent = climb.parent;
  if (
    names &&
    ids &&
    (names.length !== ids.length ||
      (ids.length > 0 && parent?.uuid != null && ids.at(-1) !== parent.uuid))
  )
    throw new Error(
      `OpenBeta tick ${tick._id} has inconsistent location path names and identities. Re-sync after the source location is corrected.`,
    );
  const coordinates = sourceCoordinates(parent?.metadata);
  if (names && names.length > 0)
    return names.map((name, index) => ({
      name,
      externalId: ids?.[index] ?? null,
      ...(coordinates !== undefined && parent?.uuid != null && ids?.[index] === parent.uuid
        ? { coordinates }
        : {}),
    }));
  const name = nullableText(parent?.area_name);
  return name
    ? [
        {
          name,
          externalId: parent?.uuid ?? null,
          ...(coordinates === undefined ? {} : { coordinates }),
        },
      ]
    : [];
}

function sourceQualifier(value: string | null, aid: boolean): SourceClimbingAttempt["qualifier"] {
  switch (value?.trim().toLowerCase()) {
    case "onsight":
      return aid ? "aid-onsight" : "free-onsight";
    case "flash":
      return aid ? "aid-flash" : "free-flash";
    case "send":
    case "redpoint":
    case "pinkpoint":
      return aid ? undefined : "free-send";
    case "fell/hung":
      return "fell-hung";
    default:
      return undefined;
  }
}

function parseOpenBetaTicks(ticks: OpenBetaTick[]): OpenBetaTickParseResult {
  const entries: SourceClimbingLogEntry[] = [];
  const errors: SyncError[] = [];
  for (const tick of ticks) {
    const climbedOn = parseOpenBetaDate(tick.dateClimbed);
    if (tick.dateClimbed !== null && climbedOn === null) {
      errors.push({
        message: `Skipped OpenBeta tick ${tick.name ?? tick._id}: invalid date ${tick.dateClimbed}.`,
        externalId: tick._id,
      });
      continue;
    }
    const sourceType = tick.climb?.type;
    const kind: ClimbKind | null =
      sourceType?.bouldering === true
        ? "boulder"
        : sourceType?.sport === true || sourceType?.trad === true
          ? "route"
          : tick.style === "Boulder"
            ? "boulder"
            : tick.style != null
              ? "route"
              : null;
    const methods: Readonly<Record<NonNullable<OpenBetaTick["style"]>, RopeMethod | null>> = {
      Lead: "lead",
      TR: "top_rope",
      Follow: "follow",
      Solo: null,
      Aid: null,
      Boulder: null,
    };
    const routeProtection =
      sourceType == null || (sourceType.sport == null && sourceType.trad == null)
        ? null
        : (["sport", "trad"] as const).filter((protection) => sourceType[protection] === true);
    const areas = locationPathForTick(tick);
    const targetId =
      nullableText(tick.climb?.uuid) ??
      (tick.source === "OB" && z.uuid().safeParse(tick.climbId).success ? tick.climbId : null);
    const coordinates = sourceCoordinates(tick.climb?.metadata);
    const qualifier = sourceQualifier(tick.attemptType, tick.style === "Aid");
    const resultLabel = tick.attemptType?.trim().toLowerCase();
    const pitches = tick.climb?.pitches
      ?.filter((value) => value !== null)
      .map((value) => {
        if (value.parentId !== tick.climb?.uuid)
          throw new Error(`OpenBeta tick ${tick._id} has an inconsistent pitch parent identity.`);
        return {
          externalId: value.id,
          ...(value.pitchNumber > 0 ? { number: value.pitchNumber } : {}),
          publishedGrades: publishedGrades(value.grades),
        };
      });
    entries.push({
      externalId: `openbeta:${tick._id}`,
      climbedOn,
      ...(kind === null ? {} : { discipline: "rock_climbing" }),
      notes: nullableText(tick.notes),
      sourceName: OPENBETA_PROVIDER_NAME,
      raw: tick,
      reportedGrades: reportedGrades(tick.grade, kind),
      attempts: [
        {
          scope: "climb",
          ropeMethod: tick.style === null ? null : methods[tick.style],
          ...(tick.style === "Solo" ? { solo: true } : {}),
          ...(tick.style === "Aid" || resultLabel === "frenchfree" ? { usedAid: true } : {}),
          ...(resultLabel === "pinkpoint" ? { usedPreplacedProtection: true } : {}),
          ...(qualifier === undefined ? {} : { qualifier }),
          ...(qualifier !== undefined || resultLabel === "attempt"
            ? { sourceResult: tick.attemptType }
            : {}),
        },
      ],
      climb: {
        externalId: targetId,
        ...(tick.climb?.name != null
          ? { name: nullableText(tick.climb.name) }
          : targetId === null && tick.name !== null
            ? { name: nullableText(tick.name) }
            : {}),
        ...(kind === null ? {} : { kind }),
        ...(tick.climb?.grades == null
          ? {}
          : { publishedGrades: publishedGrades(tick.climb.grades) }),
        ...(tick.climb == null ? {} : { routeProtection }),
        ...(pitches === undefined ? {} : { pitches }),
        ...(areas.length === 0 ? {} : { areas }),
        ...(coordinates === undefined ? {} : { coordinates }),
      },
    });
  }
  return { entries, errors };
}

async function exchangeOpenBetaProfile(
  input: string,
  fetchFn: typeof globalThis.fetch,
): Promise<TokenSet> {
  const username = parseOpenBetaUsername(input);
  const data = await fetchGraphQL(
    fetchFn,
    OPENBETA_USER_PAGE_QUERY,
    { username },
    openBetaUserPageResponseSchema,
  );
  const profile = data.userPage?.profile;
  if (!profile) throw profileConnectionError();
  return {
    accessToken: profile.userUuid,
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "ticks",
  };
}

export class OpenBetaProvider implements SyncProvider {
  readonly id = OPENBETA_PROVIDER_ID;
  readonly name = OPENBETA_PROVIDER_NAME;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: OPENBETA_API_BASE_URL,
      manualToken: {
        kind: "public-profile",
        label: "OpenBeta profile URL or username",
        instructionsUrl: "https://openbeta.io/",
        exchangeToken: (input) => exchangeOpenBetaProfile(input, this.#fetchFn),
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, options } = run;
    const startedAt = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;
    const userId = options.userId;

    if (!userId) {
      const error = new Error("OpenBeta sync requires a user context.");
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error.message, cause: error }],
        duration: Date.now() - startedAt,
      };
    }

    await ensureProvider(db, this.id, this.name, OPENBETA_API_BASE_URL, userId);
    const tokens = await loadTokens(db, this.id, userId);
    if (!tokens) {
      const error = new ProviderStoredIdentityMissingError(
        this.name,
        "public profile connection — paste your profile URL in Settings → Data Sources",
      );
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error.message, cause: error }],
        duration: Date.now() - startedAt,
      };
    }

    let pages: FetchProviderPagesResult<OpenBetaTick>;
    try {
      pages = await fetchProviderPages<OpenBetaTick, number>({
        providerId: this.id,
        stepName: "climbing_activity",
        initialCursor: 0,
        fetchPage: async (offset = 0) => {
          const data = await fetchGraphQL(
            this.#fetchFn,
            OPENBETA_TICKS_QUERY,
            { userId: tokens.accessToken, limit: OPENBETA_PAGE_SIZE, offset },
            openBetaTicksResponseSchema,
          );
          return {
            items: data.userTicks,
            nextCursor:
              data.userTicks.length === OPENBETA_PAGE_SIZE ? offset + OPENBETA_PAGE_SIZE : null,
          };
        },
      });
    } catch (error) {
      if (findProviderTransportError(error)) throw error;
      captureException(error, { tags: { provider: this.id, phase: "tick_export" } });
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
        duration: Date.now() - startedAt,
      };
    }

    let parsed: OpenBetaTickParseResult;
    try {
      // Validate every supplied path before writes or absence reconciliation.
      for (const tick of pages.items) locationPathForTick(tick);
      parsed = parseOpenBetaTicks(pages.items);
    } catch (error) {
      captureException(error, { tags: { provider: this.id, phase: "tick_context" } });
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
        duration: Date.now() - startedAt,
      };
    }
    errors.push(...parsed.errors);
    const skippedTickCount = parsed.errors.length;
    const degradations: SyncResult["degradations"] =
      skippedTickCount > 0
        ? [
            ...pages.degradations,
            {
              kind: "record_rejected",
              providerId: this.id,
              stepName: "climbing_activity",
              message: `Skipped ${skippedTickCount} OpenBeta ticks during parsing.`,
              context: {
                invalidDateCount: parsed.errors.length,
              },
            },
          ]
        : pages.degradations.length > 0
          ? pages.degradations
          : undefined;

    try {
      recordsSynced = await withSyncLog(
        db,
        this.id,
        "climbing_activity",
        async () => {
          const persist =
            pages.completed && parsed.errors.length === 0 && pages.degradations.length === 0
              ? persistClimbingLogSnapshot
              : persistClimbingLogEntries;
          const result = await persist(db, {
            userId,
            providerId: this.id,
            entries: parsed.entries,
          });
          return {
            recordCount: result.recordsSynced,
            result: result.recordsSynced,
            degradations,
          };
        },
        userId,
      );
    } catch (error) {
      captureException(error, { tags: { provider: this.id, phase: "climbing_activity" } });
      errors.push({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      degradations,
      duration: Date.now() - startedAt,
    };
  }
}
