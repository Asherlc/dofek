import { validateHeaderValue } from "node:http";
import {
  FREE_ROCK_GRADE_SYSTEMS,
  type GradeSystem,
  isGradeSystemForClimbKind,
  isValidClimbingGrade,
} from "@dofek/training/climbing-grades";
import type { ClimbKind, GradeComponent, ProtectionStyle } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../../db/tokens.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { findProviderTransportError } from "../../lib/provider-transport-error.ts";
import { fetchProviderPages } from "../../sync/pagination.ts";
import { ProviderStoredIdentityMissingError, ProviderTokenRejectedError } from "../auth-errors.ts";
import type { SyncRun } from "../sync-run.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult } from "../types.ts";
import { writeClimbingRecords } from "./persistence.ts";

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
    date: z.string().nullish(),
    climbedGearStyle: z.string().nullish(),
    markdown: z.string().nullish(),
    tick: z
      .object({ name: z.string().nullish(), label: z.string().nullish() })
      .passthrough()
      .nullish(),
    route: z
      .object({
        id: identifierSchema,
        name: z.string().nullish(),
        grade: z.string().nullish(),
        style: z.string().nullish(),
        ancestors: z.record(z.string(), locationSchema.nullable()).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

function nullableText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function sourceDate(value: string | null | undefined, ascentId: string): string | null {
  if (value == null || value.trim() === "") return null;
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

function sourceClimbKind(ascent: z.infer<typeof ascentSchema>): ClimbKind | null {
  const styles = [ascent.climbedGearStyle, ascent.route.style].map((style) =>
    style?.trim().toLowerCase(),
  );
  const isBoulder = styles.includes("boulder");
  const isRoute = styles.some((style) => style === "sport" || style === "trad" || style === "aid");
  if (isBoulder && !isRoute) return "boulder";
  if (isRoute && !isBoulder) return "route";
  if (!isRoute && !isBoulder) return null;
  throw new Error(
    `theCrag ascent ${ascent.id} has an unsupported or inconsistent climbing discipline. Review the route style or contact support before syncing this logbook.`,
  );
}

function sourceGrade(
  rawGrade: string | null | undefined,
  kind: ClimbKind | null,
  ascentId: string,
): GradeComponent[] {
  let grade = rawGrade?.trim() ?? "";
  if (grade === "") return [];
  const components =
    /^(?:V(?:B|\d)|5\.|(?:FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+))/i.test(
      grade,
    )
      ? grade.split(
          /\s+(?=(?:FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+))/i,
        )
      : [grade];
  if (components.length > 1)
    return components.flatMap((component) => sourceGrade(component, kind, ascentId));
  let gradeSystem: GradeSystem | null = null;
  if (/^V(?:B|\d+)(?:[+-])?$/i.test(grade)) gradeSystem = "v_scale";
  else if (/^5\./.test(grade)) gradeSystem = "yds";
  else {
    // theCrag documents these scale labels. gradeAtom.type is undocumented.
    const explicitScale =
      /^(FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+)(.+)$/i.exec(
        grade,
      );
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
        case "AID":
        case "AIDC":
          gradeSystem = "aid";
          break;
        case "WICE":
          gradeSystem = "water_ice";
          break;
        case "AICE":
          gradeSystem = "alpine_ice";
          break;
        case "MIXED":
          gradeSystem = "mixed";
          break;
        case "IFAS":
          gradeSystem = "ifas";
          break;
        case "NCCS":
          gradeSystem = "nccs";
          break;
        case "UK":
          gradeSystem = "british_adjectival";
          break;
        case "UKT":
          gradeSystem = "british_technical";
          break;
      }
      grade = explicitScale[2]?.trim() ?? grade;
    }
  }
  if (
    gradeSystem !== null &&
    (kind === "boulder" || kind === "route") &&
    FREE_ROCK_GRADE_SYSTEMS.some((system) => system === gradeSystem) &&
    !isGradeSystemForClimbKind(gradeSystem, kind)
  ) {
    throw new Error(
      `theCrag ascent ${ascentId} has an unsupported or ambiguous grade. Use a grade with an explicit supported scale in theCrag, or contact support before syncing this logbook.`,
    );
  }
  if (gradeSystem !== null && !isValidClimbingGrade(grade, gradeSystem)) {
    gradeSystem = null;
    grade = rawGrade?.trim() ?? "";
  }
  return [{ system: gradeSystem, value: grade }];
}

function climbingRecord(
  raw: z.infer<typeof rawAscentSchema>,
  accountId: string,
): SourceClimbingLogEntry {
  const parsed = ascentSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "theCrag returned an unsupported ascent response. Contact support before syncing this logbook.",
      { cause: parsed.error },
    );
  const ascent = parsed.data;
  const kind = sourceClimbKind(ascent);
  const grades = sourceGrade(ascent.route.grade, kind, ascent.id);
  const gearStyle = ascent.climbedGearStyle?.trim().toLowerCase();
  const protectionUsed: ProtectionStyle[] | null =
    gearStyle === "sport" || gearStyle === "trad" ? [gearStyle] : null;
  const routeStyle = ascent.route.style?.trim().toLowerCase();
  const routeProtection: ProtectionStyle[] | null =
    routeStyle === "sport" || routeStyle === "trad" ? [routeStyle] : null;
  const locationIds = new Set<string>();
  const areas = Object.values(ascent.route.ancestors ?? {})
    .filter((location) => location !== null)
    .sort((a, b) => a.depth - b.depth)
    .filter((location) => {
      if (location.id == null) return true;
      if (locationIds.has(location.id)) return false;
      locationIds.add(location.id);
      return true;
    })
    .map((location) => ({ name: location.name, externalId: location.id ?? null }));
  const sourceResult = (ascent.tick?.label?.trim() ? ascent.tick.label : ascent.tick?.name) ?? null;
  const label = sourceResult?.trim().toLowerCase();
  const usedAid =
    gearStyle === "aid" ||
    label === "french free" ||
    label === "frenchfree" ||
    label?.startsWith("aid ") === true;
  const qualifier = sourceQualifier(label ?? null, usedAid);
  const supportedResult =
    qualifier !== undefined ||
    ["attempt", "dog", "hang dog", "tick"].includes(label ?? "") ||
    (usedAid && ["clean", "send", "redpoint", "pinkpoint"].includes(label ?? ""));
  const attempt: SourceClimbingAttempt = {
    scope: "climb",
    protectionUsed,
    ...(["lead solo", "top rope solo", "aid solo"].includes(label ?? "")
      ? ({
          solo: true,
          ropeMethod:
            label === "lead solo" ? "lead" : label === "top rope solo" ? "top_rope" : null,
        } as const)
      : {}),
    ...(usedAid ? { usedAid: true } : {}),
    ...(qualifier === undefined ? {} : { qualifier }),
    ...(supportedResult ? { sourceResult } : {}),
    ...(label === "dog" || label === "hang dog" ? { fellOrHung: true } : {}),
    ...(label === "repeat" ? { hadCompletedBefore: true } : {}),
    ...(label === "ground-up redpoint" ? { priorFailedAttemptsGroundUp: true } : {}),
    ...(label === "pinkpoint" ? { usedPreplacedProtection: true } : {}),
  };
  return {
    externalId: `thecrag:${ascent.id}`,
    climbedOn: sourceDate(ascent.date, ascent.id),
    ...(kind === null ? {} : { discipline: "rock_climbing" }),
    attempts: [attempt],
    ...(ascent.markdown === undefined ? {} : { notes: nullableText(ascent.markdown) }),
    sourceName: "theCrag",
    raw: { accountId, ascent: raw },
    climb: {
      externalId: ascent.route.id,
      ...(ascent.route.name == null ? {} : { name: nullableText(ascent.route.name) }),
      ...(kind === null ? {} : { kind }),
      routeProtection,
      ...(ascent.route.grade == null || ascent.route.grade.trim() === ""
        ? {}
        : { publishedGrades: grades }),
      ...(areas.length === 0 ? {} : { areas }),
    },
  };
}

function sourceQualifier(value: string | null, aid: boolean): SourceClimbingAttempt["qualifier"] {
  switch (value?.trim().toLowerCase()) {
    case "aid onsight":
    case "onsight":
    case "on sight":
      return aid ? "aid-onsight" : "free-onsight";
    case "aid flash":
    case "flash":
      return aid ? "aid-flash" : "free-flash";
    case "clean":
    case "send":
    case "redpoint":
    case "pinkpoint":
    case "greenpoint":
    case "repeat":
    case "ground-up redpoint":
      return aid ? undefined : "free-send";
    case "fell/hung":
      return "fell-hung";
    case "dab":
      return "dab";
    default:
      return undefined;
  }
}

async function fetchLogbookPage(
  fetchFn: typeof globalThis.fetch,
  token: string,
  page: number,
  options: { signal?: AbortSignal } = {},
): Promise<z.infer<typeof logbookSchema>["data"]> {
  const url = new URL(LOGBOOK_URL);
  url.searchParams.set("page", String(page));
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
    const { db, options } = run;
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
          if (new Set(records.map((record) => record.externalId)).size !== records.length) {
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
