import {
  type ClimbingLocationNode,
  type ClimbingMetadata,
  climbingMetadataSchema,
} from "@dofek/training/climbing-context";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import { climbingEntry } from "../db/schema/activity.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { type FetchProviderPagesResult, fetchProviderPages } from "../sync/pagination.ts";
import { ProviderStoredIdentityMissingError, ProviderTokenRejectedError } from "./auth-errors.ts";
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
        grades {
          vscale
          yds
          ewbank
          french
          font
          uiaa
          brazilianCrux
        }
        type {
          bouldering
        }
        parent {
          uuid
          area_name
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

const openBetaTickSchema = z
  .object({
    _id: z.string().min(1),
    userId: z.string().nullable(),
    name: z.string().nullable(),
    notes: z.string().nullable(),
    climbId: z.string().nullable(),
    style: z.enum(["Lead", "Solo", "TR", "Follow", "Aid", "Boulder"]).nullable(),
    attemptType: z.string().trim().min(1).nullable(),
    dateClimbed: z.string().nullable(),
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
        grades: z
          .object({
            vscale: z.string().nullable(),
            yds: z.string().nullable(),
            ewbank: z.string().nullable(),
            french: z.string().nullable(),
            font: z.string().nullable(),
            uiaa: z.string().nullable(),
            brazilianCrux: z.string().nullable(),
          })
          .nullable(),
        type: z.object({ bouldering: z.boolean().nullable() }).nullable(),
        parent: z
          .object({ uuid: z.string().trim().min(1).nullish(), area_name: z.string().nullable() })
          .nullable(),
      })
      .nullable(),
  })
  .passthrough();

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
  | "brazilian_crux";

interface OpenBetaClimbingEntry extends ClimbingMetadata {
  externalId: string;
  unattachedDate: string;
  climbType: "boulder" | "route";
  gradeSystem: OpenBetaGradeSystem;
  grade: string;
  attemptCount: number | null;
  routeName: string | null;
  raw: OpenBetaTick;
}

interface OpenBetaTickParseResult {
  entries: OpenBetaClimbingEntry[];
  errors: SyncError[];
  unsupportedGradeCount: number;
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

function profileConnectionError(): ProviderTokenRejectedError {
  return new ProviderTokenRejectedError(
    OPENBETA_PROVIDER_NAME,
    "Paste a public OpenBeta profile URL or username, and make sure the profile is public.",
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
      throw new ProviderTokenRejectedError(
        OPENBETA_PROVIDER_NAME,
        profileConnectionError().message,
        { cause: error },
      );
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
      throw new ProviderTokenRejectedError(
        OPENBETA_PROVIDER_NAME,
        profileConnectionError().message,
        { cause: error },
      );
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

function parseOpenBetaDate(value: string | null): string | null {
  const date = value?.slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function gradeFromTick(
  tick: OpenBetaTick,
  climbType: "boulder" | "route",
): { gradeSystem: OpenBetaGradeSystem; grade: string } | null {
  const grades = tick.climb?.grades;
  const candidates: Array<{ gradeSystem: OpenBetaGradeSystem; grade: string | null }> =
    climbType === "boulder"
      ? [
          { gradeSystem: "v_scale", grade: grades?.vscale ?? null },
          { gradeSystem: "font", grade: grades?.font ?? null },
        ]
      : [
          { gradeSystem: "yds", grade: grades?.yds ?? null },
          { gradeSystem: "french", grade: grades?.french ?? null },
          { gradeSystem: "uiaa", grade: grades?.uiaa ?? null },
          { gradeSystem: "ewbank", grade: grades?.ewbank ?? null },
          { gradeSystem: "brazilian_crux", grade: grades?.brazilianCrux ?? null },
        ];

  for (const candidate of candidates) {
    const grade = nullableText(candidate.grade);
    if (grade) return { gradeSystem: candidate.gradeSystem, grade };
  }

  const tickGrade = nullableText(tick.grade);
  if (!tickGrade) return null;
  if (climbType === "boulder" && /^v\d+(?:[+-])?$/i.test(tickGrade)) {
    return { gradeSystem: "v_scale", grade: tickGrade };
  }
  if (climbType === "boulder" && /^\d+[a-c](?:[+-])?$/i.test(tickGrade)) {
    return { gradeSystem: "font", grade: tickGrade };
  }
  if (climbType === "route" && /^5\./.test(tickGrade)) {
    return { gradeSystem: "yds", grade: tickGrade };
  }
  if (climbType === "route" && /^\d+[a-c](?:[+-])?$/i.test(tickGrade)) {
    return { gradeSystem: "french", grade: tickGrade };
  }
  return null;
}

function locationPathForTick(tick: OpenBetaTick): ClimbingLocationNode[] {
  const climb = tick.climb;
  if (!climb) return [];
  const names = climb.pathTokens;
  const ids = climb.ancestors;
  const parent = climb.parent;
  if (
    names &&
    ids &&
    (names.length !== ids.length || (parent?.uuid != null && ids.at(-1) !== parent.uuid))
  ) {
    throw new Error(
      `OpenBeta tick ${tick._id} has inconsistent location path names and identities. Re-sync after the source location is corrected.`,
    );
  }
  if (names && names.length > 0)
    return names.map((name, index) => ({ name, externalId: ids?.[index] ?? null, kind: null }));
  const name = nullableText(parent?.area_name);
  return name ? [{ name, externalId: parent?.uuid ?? null, kind: null }] : [];
}

function parseOpenBetaTicks(ticks: OpenBetaTick[]): OpenBetaTickParseResult {
  const entries: OpenBetaClimbingEntry[] = [];
  const errors: SyncError[] = [];
  let unsupportedGradeCount = 0;

  for (const tick of ticks) {
    const unattachedDate = parseOpenBetaDate(tick.dateClimbed);
    if (!unattachedDate) {
      errors.push({
        message: `Skipped OpenBeta tick ${tick.name ?? tick._id}: invalid date ${tick.dateClimbed ?? "(empty)"}.`,
        externalId: tick._id,
      });
      continue;
    }

    const climbType = tick.climb?.type?.bouldering === true ? "boulder" : "route";
    const grade = gradeFromTick(tick, climbType);
    if (!grade) {
      unsupportedGradeCount++;
      continue;
    }

    const methods = {
      Lead: "lead",
      TR: "top-rope",
      Follow: "follow",
      Solo: "solo",
      Aid: "aid",
      Boulder: null,
    } as const;
    entries.push({
      externalId: `openbeta:${tick._id}`,
      unattachedDate,
      climbType,
      gradeSystem: grade.gradeSystem,
      grade: grade.grade,
      ...climbingMetadataSchema.parse({
        locationPath: locationPathForTick(tick),
        board: null,
        wallAngle: null,
        climbStyle: tick.style === null ? null : methods[tick.style],
        resultStyle: tick.attemptType,
      }),
      attemptCount: null,
      routeName: nullableText(tick.name ?? tick.climb?.name),
      raw: tick,
    });
  }

  return { entries, errors, unsupportedGradeCount };
}

async function exchangeOpenBetaProfile(
  input: string,
  fetchFn: typeof globalThis.fetch,
): Promise<TokenSet> {
  const username = parseOpenBetaUsername(input);
  try {
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
  } catch (error) {
    if (error instanceof ProviderTokenRejectedError) throw error;
    throw new ProviderTokenRejectedError(OPENBETA_PROVIDER_NAME, profileConnectionError().message, {
      cause: error,
    });
  }
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
    if (parsed.unsupportedGradeCount > 0) {
      errors.push({
        message: `Skipped ${parsed.unsupportedGradeCount} OpenBeta ticks with unsupported or missing grades.`,
        context: { unsupportedGradeCount: parsed.unsupportedGradeCount },
      });
    }
    const skippedTickCount = parsed.errors.length + parsed.unsupportedGradeCount;
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
                unsupportedGradeCount: parsed.unsupportedGradeCount,
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
          let count = 0;
          const presentExternalIds = parsed.entries.map((entry) => entry.externalId);
          for (const entry of parsed.entries) {
            await db
              .insert(climbingEntry)
              .values({
                userId,
                providerId: this.id,
                activityId: null,
                unattachedDate: entry.unattachedDate,
                externalId: entry.externalId,
                climbType: entry.climbType,
                gradeSystem: entry.gradeSystem,
                grade: entry.grade,
                resultStyle: entry.resultStyle,
                climbStyle: entry.climbStyle,
                board: entry.board,
                wallAngle: entry.wallAngle,
                attemptCount: entry.attemptCount,
                routeName: entry.routeName,
                locationPath: entry.locationPath,
                sourceName: this.name,
                raw: entry.raw,
              })
              .onConflictDoUpdate({
                target: [climbingEntry.userId, climbingEntry.providerId, climbingEntry.externalId],
                targetWhere: sql`${climbingEntry.providerId} = 'openbeta' AND ${climbingEntry.externalId} IS NOT NULL`,
                set: {
                  climbType: entry.climbType,
                  gradeSystem: entry.gradeSystem,
                  grade: entry.grade,
                  resultStyle: entry.resultStyle,
                  climbStyle: entry.climbStyle,
                  board: entry.board,
                  wallAngle: entry.wallAngle,
                  attemptCount: entry.attemptCount,
                  routeName: entry.routeName,
                  locationPath: entry.locationPath,
                  sourceName: this.name,
                  raw: entry.raw,
                  providerAbsentAt: null,
                },
              });
            count++;
          }

          if (
            presentExternalIds.length > 0 &&
            parsed.errors.length === 0 &&
            parsed.unsupportedGradeCount === 0 &&
            pages.degradations.length === 0
          ) {
            const presentIdsSql = sql.join(
              presentExternalIds.map((externalId) => sql`${externalId}`),
              sql`, `,
            );
            await db.execute(sql`
              UPDATE fitness.climbing_entry
              SET provider_absent_at = NOW()
              WHERE user_id = ${userId}
                AND provider_id = ${this.id}
                AND provider_absent_at IS NULL
                AND external_id IS NOT NULL
                AND external_id NOT IN (${presentIdsSql})
            `);
          }
          return { recordCount: count, result: count, degradations };
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
