import { createHash } from "node:crypto";
import {
  MountainProjectClient,
  MountainProjectTickExportError,
  parseMountainProjectProfileId,
} from "@dofek/mountain-project/client";
import { normalizeMountainProjectGrade } from "@dofek/mountain-project/grades";
import {
  decodeMountainProjectTickExport,
  type MountainProjectTick,
} from "@dofek/mountain-project/ticks";
import {
  type ClimbingMetadata,
  type ClimbingStyle,
  climbingMetadataSchema,
} from "@dofek/training/climbing-context";
import { sql } from "drizzle-orm";
import type { TokenSet } from "../auth/oauth.ts";
import { climbingEntry } from "../db/schema/activity.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { ProviderStoredIdentityMissingError, ProviderTokenRejectedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

const MOUNTAIN_PROJECT_BASE_URL = "https://www.mountainproject.com";
const MOUNTAIN_PROJECT_PROVIDER_ID = "mountain-project";
const MOUNTAIN_PROJECT_PROVIDER_NAME = "Mountain Project";

interface MountainProjectClimbingEntry extends ClimbingMetadata {
  externalId: string;
  climbType: "boulder" | "route";
  gradeSystem: "v_scale" | "yds";
  grade: string;
  attemptCount: number | null;
  routeName: string | null;
  raw: MountainProjectTick["raw"];
  routeProtection: Array<"sport" | "trad"> | null;
}

interface TickExportParseResult {
  entries: Array<MountainProjectClimbingEntry & { unattachedDate: string }>;
  unsupportedGradeCount: number;
  errors: SyncError[];
}

export class MountainProjectProvider implements SyncProvider {
  readonly id = MOUNTAIN_PROJECT_PROVIDER_ID;
  readonly name = MOUNTAIN_PROJECT_PROVIDER_NAME;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const client = new MountainProjectClient(this.#fetchFn);
    return {
      apiBaseUrl: MOUNTAIN_PROJECT_BASE_URL,
      // Mountain Project has no user API token; manualToken stores the public profile identifier.
      manualToken: {
        label: "Mountain Project profile URL",
        instructionsUrl: "https://www.mountainproject.com/",
        exchangeToken: async (input: string): Promise<TokenSet> => {
          const userId = parseMountainProjectProfileId(input);
          try {
            const csv = await client.getTickExport(userId);
            const decoded = decodeMountainProjectTickExport(csv);
            if (!decoded.ok) {
              throw new ProviderTokenRejectedError(
                this.name,
                "Paste your public Mountain Project profile URL and check that your ticks are not set to private.",
              );
            }
          } catch (error) {
            if (error instanceof ProviderTokenRejectedError) throw error;
            throw new ProviderTokenRejectedError(
              this.name,
              "Paste your public Mountain Project profile URL and check that your ticks are not set to private.",
              { cause: error },
            );
          }
          return {
            accessToken: userId,
            refreshToken: null,
            expiresAt: new Date("2099-12-31T00:00:00.000Z"),
            scopes: "ticks",
          };
        },
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
      const error = new Error("Mountain Project sync requires a user context.");
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error.message, cause: error }],
        duration: Date.now() - startedAt,
      };
    }
    await ensureProvider(db, this.id, this.name, MOUNTAIN_PROJECT_BASE_URL, userId);

    const tokens = await loadTokens(db, this.id, userId);
    if (!tokens) {
      const error = new ProviderStoredIdentityMissingError(
        this.name,
        "profile connection — paste your profile URL in Settings → Data Sources",
      );
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error.message, cause: error }],
        duration: Date.now() - startedAt,
      };
    }

    let parsed: TickExportParseResult;
    try {
      const csv = await new MountainProjectClient(this.#fetchFn).getTickExport(tokens.accessToken);
      const decoded = decodeMountainProjectTickExport(csv);
      if (!decoded.ok) throw new Error(`Mountain Project tick export ${decoded.message}.`);
      parsed = parseMountainProjectTicks(decoded.ticks);
    } catch (error) {
      if (!(error instanceof MountainProjectTickExportError && error.status === 404)) {
        captureException(error, { tags: { provider: this.id, phase: "tick_export" } });
      }
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
        duration: Date.now() - startedAt,
      };
    }

    errors.push(...parsed.errors);
    if (parsed.unsupportedGradeCount > 0) {
      errors.push({
        message: `Skipped ${parsed.unsupportedGradeCount} Mountain Project ticks with unsupported grades.`,
        context: { unsupportedGradeCount: parsed.unsupportedGradeCount },
      });
    }

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
                routeProtection: entry.routeProtection,
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
                targetWhere: sql`${climbingEntry.providerId} = 'mountain-project' AND ${climbingEntry.externalId} IS NOT NULL`,
                set: {
                  climbType: entry.climbType,
                  gradeSystem: entry.gradeSystem,
                  grade: entry.grade,
                  resultStyle: entry.resultStyle,
                  climbStyle: entry.climbStyle,
                  routeProtection: entry.routeProtection,
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
            parsed.unsupportedGradeCount === 0
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
          return { recordCount: count, result: count };
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

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - startedAt };
  }
}

function parseMountainProjectTicks(ticks: MountainProjectTick[]): TickExportParseResult {
  const entries: TickExportParseResult["entries"] = [];
  const occurrenceByFingerprint = new Map<string, number>();
  const errors: SyncError[] = [];
  let unsupportedGradeCount = 0;

  for (const tick of ticks) {
    const date = parseExportDate(tick.date);
    if (!date) {
      errors.push({
        message: `Skipped Mountain Project tick with invalid date: ${tick.date || "(empty)"}.`,
      });
      continue;
    }
    const locationName = tick.location.trim();
    if (!locationName) {
      errors.push({
        message: `Skipped Mountain Project tick ${tick.route || "(unnamed route)"}: location is required.`,
      });
      continue;
    }
    const parsedGrade = normalizeMountainProjectGrade(tick.rating);
    if (!parsedGrade) {
      unsupportedGradeCount++;
      continue;
    }
    const dateKey = date.toISOString().slice(0, 10);
    const fingerprint = [dateKey, tick.url, tick.style, tick.leadStyle, tick.pitches].join(
      "\u001f",
    );
    const occurrence = occurrenceByFingerprint.get(fingerprint) ?? 0;
    occurrenceByFingerprint.set(fingerprint, occurrence + 1);
    const externalId = `mountain-project:tick:${stableHash([fingerprint, String(occurrence)])}`;
    const climbType = isBoulder(tick) ? "boulder" : "route";
    const methods: Readonly<Record<string, ClimbingStyle>> = {
      Lead: "lead",
      TR: "top-rope",
      Follow: "follow",
      Solo: "solo",
      Aid: "aid",
    };
    const metadata = climbingMetadataSchema.parse({
      locationPath: locationName
        .split(">")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ name, externalId: null, kind: null })),
      board: null,
      wallAngle: null,
      climbStyle: climbType === "boulder" ? null : (methods[tick.style] ?? null),
      resultStyle: nullableText(climbType === "boulder" ? tick.style : tick.leadStyle),
    });
    entries.push({
      externalId,
      unattachedDate: dateKey,
      climbType,
      gradeSystem: parsedGrade.gradeSystem,
      grade: parsedGrade.grade,
      ...metadata,
      routeProtection: tick.routeType.trim()
        ? tick.routeType.split(",").flatMap((value) => {
            const type = value.trim().toLowerCase();
            return type === "sport" || type === "trad" ? [type] : [];
          })
        : null,
      attemptCount: null,
      routeName: nullableText(tick.route),
      raw: tick.raw,
    });
  }

  return { entries, unsupportedGradeCount, errors };
}

function parseExportDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

function isBoulder(tick: MountainProjectTick): boolean {
  return (
    tick.routeType.split(",").some((type) => type.trim().toLowerCase() === "boulder") ||
    Number(tick.ratingCode) >= 20_000
  );
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
}
