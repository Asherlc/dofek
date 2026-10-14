import { validateHeaderValue } from "node:http";
import {
  type ClimbingClimbType,
  type ClimbingGradeSystem,
  isGradeSystemForClimbType,
  isValidClimbingGrade,
} from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import { executeWithSchema } from "../db/execute-with-schema.ts";
import type { SyncDatabase } from "../db/index.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { findProviderTransportError } from "../lib/provider-transport-error.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import { ProviderStoredIdentityMissingError, ProviderTokenRejectedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult } from "./types.ts";

const API_BASE_URL = "https://www.thecrag.com/api";
const LOGBOOK_URL = `${API_BASE_URL}/logbook/ascents`;
const identifierSchema = z
  .union([z.string().trim().min(1), z.number().int().positive().safe()])
  .transform(String);
const unsignedIntegerSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().safe());
const rawAscentSchema = z.json();
const logbookSchema = z
  .object({
    data: z
      .object({
        account: z.object({ id: identifierSchema }).passthrough(),
        ascents: z.array(rawAscentSchema),
        numberAscents: unsignedIntegerSchema,
        page: unsignedIntegerSchema.refine((page) => page >= 1),
        perPage: unsignedIntegerSchema.refine((size) => size >= 1),
      })
      .passthrough(),
  })
  .passthrough();
const locationSchema = z
  .object({
    id: identifierSchema.nullish(),
    name: z.string().trim().min(1),
    depth: unsignedIntegerSchema,
  })
  .passthrough();
const ascentSchema = z
  .object({
    id: identifierSchema,
    epoch: unsignedIntegerSchema,
    date: z.string(),
    climbedGearStyle: z.string().nullish(),
    tick: z
      .object({ name: z.string().nullish(), label: z.string().nullish() })
      .passthrough()
      .nullish(),
    route: z
      .object({
        id: identifierSchema,
        name: z.string().nullish(),
        grade: z.string(),
        style: z.string().nullish(),
        ancestors: z.record(z.string(), locationSchema.nullable()).nullish(),
      })
      .passthrough(),
  })
  .passthrough();
const cursorRowSchema = z.object({ epoch: unsignedIntegerSchema.nullable() });
const writtenRowSchema = z.object({ id: z.string().min(1) });

function nullableText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function sourceDate(value: string, ascentId: string): string {
  const day = value.slice(0, 10);
  const isCompleteIsoDate = z.iso.date().safeParse(value).success;
  const isCompleteIsoTimestamp = z.iso
    .datetime({ offset: true, local: true })
    .safeParse(value).success;
  if (
    (!isCompleteIsoDate && !isCompleteIsoTimestamp) ||
    day.startsWith("0000-") ||
    !z.iso.date().safeParse(day).success
  ) {
    throw new Error(
      `theCrag ascent ${ascentId} has an incomplete or invalid climb date. Record the exact climb day in theCrag and sync again.`,
    );
  }
  return day;
}

function sourceClimbType(ascent: z.infer<typeof ascentSchema>): ClimbingClimbType {
  const styles = [ascent.climbedGearStyle, ascent.route.style].map((style) =>
    style?.trim().toLowerCase(),
  );
  const isBoulder = styles.includes("boulder");
  const isRoute = styles.some((style) => style === "sport" || style === "trad");
  if (isBoulder && !isRoute) return "boulder";
  if (isRoute && !isBoulder) return "route";
  throw new Error(
    `theCrag ascent ${ascent.id} has an unsupported or inconsistent climbing discipline. Review the route style or contact support before syncing this logbook.`,
  );
}

function sourceGrade(
  rawGrade: string,
  climbType: ClimbingClimbType,
  ascentId: string,
): { gradeSystem: ClimbingGradeSystem; grade: string } {
  let grade = rawGrade.trim();
  let gradeSystem: ClimbingGradeSystem | null = null;
  if (/^V(?:B|\d+)(?:[+-])?$/i.test(grade)) gradeSystem = "v_scale";
  else if (/^5\./.test(grade)) gradeSystem = "yds";
  else {
    // theCrag documents these scale labels. gradeAtom.type is undocumented.
    const explicitScale = /^(FR|FB|AU|UIAA|YDS|BLDV)(?:\s*:\s*|\s+)(.+)$/i.exec(grade);
    if (explicitScale) {
      switch (explicitScale[1]?.toUpperCase()) {
        case "FR":
          gradeSystem = "french";
          break;
        case "FB":
          gradeSystem = "font";
          break;
        case "AU":
          gradeSystem = "ewbank";
          break;
        case "UIAA":
          gradeSystem = "uiaa";
          break;
        case "YDS":
          gradeSystem = "yds";
          break;
        case "BLDV":
          gradeSystem = "v_scale";
          break;
      }
      grade = explicitScale[2]?.trim() ?? grade;
    }
  }
  if (
    gradeSystem === null ||
    !isGradeSystemForClimbType(gradeSystem, climbType) ||
    !isValidClimbingGrade(grade, gradeSystem)
  ) {
    throw new Error(
      `theCrag ascent ${ascentId} has an unsupported or ambiguous grade. Use a grade with an explicit supported scale in theCrag, or contact support before syncing this logbook.`,
    );
  }
  return { gradeSystem, grade };
}

function climbingRecord(raw: z.infer<typeof rawAscentSchema>, accountId: string) {
  const parsed = ascentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "theCrag returned an unsupported ascent response. Contact support before syncing this logbook.",
      {
        cause: parsed.error,
      },
    );
  }
  const ascent = parsed.data;
  const climbType = sourceClimbType(ascent);
  const grade = sourceGrade(ascent.route.grade, climbType, ascent.id);
  const gearStyle = ascent.climbedGearStyle?.trim().toLowerCase();
  const routeProtection = gearStyle === "sport" || gearStyle === "trad" ? [gearStyle] : null;
  const locationIds = new Set<string>();
  const locations = Object.values(ascent.route.ancestors ?? {})
    .filter((location) => location !== null)
    .sort((left, right) => left.depth - right.depth)
    .filter((location) => {
      if (location.id == null) return true;
      if (locationIds.has(location.id)) return false;
      locationIds.add(location.id);
      return true;
    });
  return {
    external_id: `thecrag:${ascent.id}`,
    unattached_date: sourceDate(ascent.date, ascent.id),
    climb_type: climbType,
    grade_system: grade.gradeSystem,
    grade: grade.grade,
    result_style: nullableText(ascent.tick?.name) ?? nullableText(ascent.tick?.label),
    attempt_count: null,
    climb_style: null,
    route_protection: routeProtection,
    board: null,
    wall_angle: null,
    route_name: nullableText(ascent.route.name),
    location_path: locations.map((location) => ({
      name: location.name,
      externalId: location.id ?? null,
      kind: null,
    })),
    source_name: "theCrag",
    raw: { accountId, ascent: raw },
  };
}

async function incrementalSince(
  database: SyncDatabase,
  userId: string,
  providerId: string,
  accountId: string,
): Promise<number | undefined> {
  const [cursor] = await executeWithSchema(
    database,
    cursorRowSchema,
    sql`
    SELECT max((raw -> 'ascent' ->> 'epoch')::bigint) AS epoch
    FROM fitness.climbing_entry
    WHERE user_id = ${userId}::uuid AND provider_id = ${providerId}
      AND raw ->> 'accountId' = ${accountId}
  `,
  );
  if (!cursor) throw new Error("theCrag sync could not read its saved update position. Try again.");
  return cursor.epoch === null ? undefined : Math.max(0, cursor.epoch - 1);
}

async function writeClimbingRecords(
  database: SyncDatabase,
  userId: string,
  providerId: string,
  records: ReturnType<typeof climbingRecord>[],
): Promise<number> {
  if (records.length === 0) return 0;
  // One PostgreSQL statement commits all ascents or none, including their raw epochs.
  // JSON keeps the batch below PostgreSQL's bind-parameter limit for large logbooks.
  try {
    const written = await executeWithSchema(
      database,
      writtenRowSchema,
      sql`
    INSERT INTO fitness.climbing_entry (
      user_id, provider_id, activity_id, unattached_date, external_id,
      climb_type, grade_system, grade, result_style, attempt_count, climb_style,
      route_protection, board, wall_angle, route_name, location_path, source_name, raw
    )
    SELECT ${userId}::uuid, ${providerId}, NULL::uuid, record.unattached_date::date,
      record.external_id, record.climb_type::fitness.climbing_climb_type,
      record.grade_system::fitness.climbing_grade_system, record.grade,
      record.result_style, record.attempt_count, record.climb_style,
      record.route_protection, record.board, record.wall_angle, record.route_name,
      record.location_path, record.source_name, record.raw
    FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS record(
      external_id text, unattached_date text, climb_type text, grade_system text,
      grade text, result_style text, attempt_count integer, climb_style text,
      route_protection text[], board jsonb, wall_angle jsonb, route_name text,
      location_path jsonb, source_name text, raw jsonb
    )
    ON CONFLICT (user_id, provider_id, external_id)
      WHERE provider_id = 'thecrag' AND external_id IS NOT NULL
    DO UPDATE SET
      unattached_date = CASE WHEN climbing_entry.activity_id IS NULL
        THEN excluded.unattached_date ELSE NULL END,
      climb_type = excluded.climb_type, grade_system = excluded.grade_system,
      grade = excluded.grade, result_style = excluded.result_style,
      attempt_count = excluded.attempt_count, climb_style = excluded.climb_style,
      route_protection = excluded.route_protection, board = excluded.board,
      wall_angle = excluded.wall_angle, route_name = excluded.route_name,
      location_path = excluded.location_path, source_name = excluded.source_name,
      raw = excluded.raw
    RETURNING id
  `,
    );
    return written.length;
  } catch (error) {
    // Drizzle query errors include the complete bound logbook payload.
    const sanitized = new Error(
      "theCrag could not save your logbook. Try again or contact support.",
    );
    const postgresCode = z
      .object({ code: z.string().regex(/^[0-9A-Z]{5}$/) })
      .safeParse(error instanceof Error ? (error.cause ?? error) : error);
    captureException(sanitized, {
      tags: {
        provider: providerId,
        phase: "logbook_save",
        ...(postgresCode.success ? { postgresCode: postgresCode.data.code } : {}),
      },
    });
    throw sanitized;
  }
}

async function fetchLogbookPage(
  fetchFn: typeof globalThis.fetch,
  token: string,
  page: number,
  options: { since?: number; signal?: AbortSignal } = {},
): Promise<z.infer<typeof logbookSchema>["data"]> {
  const url = new URL(LOGBOOK_URL);
  url.searchParams.set("page", String(page));
  if (options.since !== undefined) url.searchParams.set("since", String(options.since));
  const response = await fetchFn(url.href, {
    headers: { Accept: "application/json", "X-CData-Key": `key=${token}` },
    signal: options.signal,
  });
  if (response.status === 401) {
    throw new ProviderTokenRejectedError(
      "theCrag",
      "Check that your theCrag supporter subscription is active, then create a new API key and reconnect.",
    );
  }
  if (response.status === 403) {
    throw new Error(
      "theCrag logbook access was denied (403). Check your supporter subscription and API key, then try again when the service allows access.",
    );
  }
  if (!response.ok)
    throw new Error(`theCrag logbook request failed (${response.status}). Try again.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // JSON decoding errors may include API keys or private notes from the body.
    const safeError =
      error instanceof SyntaxError
        ? new Error("theCrag returned invalid logbook JSON. Try again or contact support.")
        : error;
    captureException(safeError, { tags: { provider: "thecrag", phase: "logbook_response" } });
    throw safeError;
  }
  const parsed = logbookSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("theCrag returned an invalid logbook response. Try again or contact support.", {
      cause: parsed.error,
    });
  }
  return parsed.data.data;
}

export class TheCragProvider implements SyncProvider {
  readonly id = "thecrag";
  readonly name = "theCrag";

  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn);
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: API_BASE_URL,
      manualToken: {
        kind: "access-token",
        label: "Personal API key (active supporter required)",
        instructionsUrl: "https://www.thecrag.com/en/article/logbookreadapi",
        exchangeToken: async (input): Promise<TokenSet> => {
          const token = input.trim();
          if (!token)
            throw new ProviderTokenRejectedError(this.name, "Paste your personal API key.");
          try {
            validateHeaderValue("X-CData-Key", `key=${token}`);
          } catch {
            throw new ProviderTokenRejectedError(
              this.name,
              "Paste your personal API key again from theCrag API settings. The pasted key contains invalid characters.",
            );
          }
          const logbook = await fetchLogbookPage(this.#fetchFn, token, 1);
          return {
            accessToken: token,
            refreshToken: null,
            expiresAt: new Date("2099-12-31T00:00:00.000Z"),
            scopes: "logbook:read",
            providerAccountId: logbook.account.id,
          };
        },
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const startedAt = Date.now();
    const { db, options, window } = run;
    let recordsSynced = 0;
    try {
      const userId = options.userId;
      if (!userId) throw new Error("theCrag sync requires a user context.");
      await ensureProvider(db, this.id, this.name, API_BASE_URL, userId);
      const tokens = await loadTokens(db, this.id, userId);
      if (!tokens)
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "API key — reconnect in Data Sources",
        );
      const accountId = identifierSchema.safeParse(tokens.providerAccountId);
      if (!accountId.success) {
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "account identity — reconnect in Data Sources",
        );
      }
      const since =
        options.origin === "scheduled" && window.kind === "bounded"
          ? await incrementalSince(db, userId, this.id, accountId.data)
          : undefined;
      recordsSynced = await withSyncLog(
        db,
        this.id,
        "climbing_activity",
        async () => {
          let expectedTotal: number | undefined;
          let expectedPageSize: number | undefined;
          let receivedCount = 0;
          const pages = await fetchProviderPages<z.infer<typeof rawAscentSchema>, number>({
            providerId: this.id,
            stepName: "climbing_activity",
            initialCursor: 1,
            fetchPage: async (page = 1) => {
              const data = await fetchLogbookPage(this.#fetchFn, tokens.accessToken, page, {
                since,
                signal: options.signal,
              });
              if (data.account.id !== accountId.data) {
                throw new Error(
                  "theCrag returned a different account. Reconnect your intended account in Data Sources.",
                );
              }
              if (
                data.page !== page ||
                (expectedTotal !== undefined && data.numberAscents !== expectedTotal) ||
                (expectedPageSize !== undefined && data.perPage !== expectedPageSize) ||
                data.ascents.length > data.perPage
              ) {
                throw new Error(
                  "theCrag returned inconsistent logbook pagination. Try syncing again.",
                );
              }
              expectedTotal = data.numberAscents;
              expectedPageSize = data.perPage;
              receivedCount += data.ascents.length;
              const nextCursor = page * data.perPage < data.numberAscents ? page + 1 : null;
              if (
                (nextCursor !== null && data.ascents.length !== data.perPage) ||
                (nextCursor === null && receivedCount !== data.numberAscents)
              ) {
                throw new Error("theCrag returned an incomplete logbook page. Try syncing again.");
              }
              return { items: data.ascents, nextCursor };
            },
          });
          if (!pages.completed || pages.degradations.length > 0) {
            throw new Error(
              "theCrag logbook pagination could not complete. Try again or contact support.",
            );
          }
          const records = pages.items.map((ascent) => climbingRecord(ascent, accountId.data));
          if (new Set(records.map((record) => record.external_id)).size !== records.length) {
            throw new Error("theCrag returned duplicate ascent identities. Try syncing again.");
          }
          const recordCount = await writeClimbingRecords(db, userId, this.id, records);
          return { recordCount, result: recordCount };
        },
        userId,
      );
      return { provider: this.id, recordsSynced, errors: [], duration: Date.now() - startedAt };
    } catch (error) {
      captureException(error, { tags: { provider: this.id, phase: "climbing_activity" } });
      if (findProviderTransportError(error)) throw error;
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
        duration: Date.now() - startedAt,
      };
    }
  }
}
