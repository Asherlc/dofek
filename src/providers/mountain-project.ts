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
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { eq } from "drizzle-orm";
import type { TokenSet } from "../auth/oauth.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
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

interface MountainProjectClimbingEntry {
  externalId: string;
  climbType: "boulder" | "route";
  gradeSystem: "v_scale" | "yds";
  grade: string;
  sent: boolean | null;
  attemptCount: number | null;
  routeName: string | null;
  locationName: string;
  raw: MountainProjectTick["raw"];
}

interface MountainProjectActivity {
  externalId: string;
  name: string;
  startedAt: Date;
  entries: MountainProjectClimbingEntry[];
}

interface TickExportParseResult {
  activities: MountainProjectActivity[];
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
    const { db, options, window } = run;
    const startedAt = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;
    await ensureProvider(db, this.id, this.name, MOUNTAIN_PROJECT_BASE_URL, options.userId);

    const tokens = await loadTokens(db, this.id, options.userId);
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

    const presentExternalIds = new Set<string>();
    try {
      recordsSynced = await withSyncLog(
        db,
        this.id,
        "climbing_activity",
        async () => {
          let count = 0;
          for (const activity of parsed.activities) {
            const row = await upsertProviderActivity(
              db,
              {
                providerId: this.id,
                userId: options.userId,
                externalId: activity.externalId,
                activityType: resolveProviderActivityType("rock_climbing", "rock_climbing"),
                name: activity.name,
                startedAt: activity.startedAt,
                endedAt: activity.startedAt,
                sourceName: this.name,
                raw: { source: this.id, locationName: activity.entries[0]?.locationName ?? null },
              },
              {
                activityType: resolveProviderActivityType("rock_climbing", "rock_climbing"),
                name: activity.name,
                startedAt: activity.startedAt,
                endedAt: activity.startedAt,
                sourceName: this.name,
                raw: { source: this.id, locationName: activity.entries[0]?.locationName ?? null },
              },
            );
            presentExternalIds.add(activity.externalId);
            if (!row) continue;
            await db.delete(climbingEntry).where(eq(climbingEntry.activityId, row.id));
            await db.insert(climbingEntry).values(
              activity.entries.map((entry) => ({
                activityId: row.id,
                externalId: entry.externalId,
                climbType: entry.climbType,
                gradeSystem: entry.gradeSystem,
                grade: entry.grade,
                sent: entry.sent,
                attemptCount: entry.attemptCount,
                routeName: entry.routeName,
                locationName: entry.locationName,
                sourceName: this.name,
                raw: entry.raw,
              })),
            );
            count += activity.entries.length;
          }
          await finishProviderActivityListSync(db, {
            providerId: this.id,
            userId: options.userId,
            windowStart: new Date(0),
            windowEnd: window.until,
            presentExternalIds,
          });
          return { recordCount: count, result: count };
        },
        options.userId,
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
  const activities = new Map<string, MountainProjectActivity>();
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
    const activityKey = `${dateKey}\u001f${locationName}`;
    let activity = activities.get(activityKey);
    if (!activity) {
      activity = {
        externalId: `mountain-project:session:${stableHash([dateKey, locationName])}`,
        name: `Mountain Project climbing at ${locationName}`,
        startedAt: date,
        entries: [],
      };
      activities.set(activityKey, activity);
    }
    const climbType = isBoulder(tick) ? "boulder" : "route";
    const sent = sentForTick(tick, climbType);
    activity.entries.push({
      externalId,
      climbType,
      gradeSystem: parsedGrade.gradeSystem,
      grade: parsedGrade.grade,
      sent,
      attemptCount: sent === null ? null : 1,
      routeName: nullableText(tick.route),
      locationName,
      raw: tick.raw,
    });
  }

  return { activities: Array.from(activities.values()), unsupportedGradeCount, errors };
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

function sentForTick(tick: MountainProjectTick, climbType: "boulder" | "route"): boolean | null {
  if (climbType === "boulder") {
    if (["Send", "Flash"].includes(tick.style)) return true;
    return tick.style === "Attempt" ? false : null;
  }
  if (["Onsight", "Flash", "Redpoint", "Pinkpoint"].includes(tick.leadStyle)) return true;
  return tick.leadStyle === "Fell/Hung" ? false : null;
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
}
