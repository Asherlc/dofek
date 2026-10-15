import { createHash } from "node:crypto";
import {
  type MountainProjectArea,
  MountainProjectClient,
  type MountainProjectRoute,
  MountainProjectTickExportError,
  parseMountainProjectProfileId,
} from "@dofek/mountain-project/client";
import { parseMountainProjectGrades } from "@dofek/mountain-project/grades";
import {
  decodeMountainProjectTickExport,
  type MountainProjectTick,
} from "@dofek/mountain-project/ticks";
import type { ProtectionStyle, RopeMethod } from "@dofek/training/climbing-log";
import { sql } from "drizzle-orm";
import type { TokenSet } from "../auth/oauth.ts";
import {
  persistClimbingLogEntries,
  type SourceClimbingAttempt,
  type SourceClimbingLogEntry,
} from "../db/climbing-log-sync.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { ProviderStoredIdentityMissingError, ProviderTokenRejectedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

const MOUNTAIN_PROJECT_BASE_URL = "https://www.mountainproject.com";
const MOUNTAIN_PROJECT_PROVIDER_ID = "mountain-project";
const MOUNTAIN_PROJECT_PROVIDER_NAME = "Mountain Project";

interface TickExportParseResult {
  entries: MountainProjectLogEntry[];
  errors: SyncError[];
}

type MountainProjectLogEntry = Omit<SourceClimbingLogEntry, "raw" | "climb"> & {
  raw: MountainProjectRoute["raw"];
  climb: NonNullable<SourceClimbingLogEntry["climb"]>;
};

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
        kind: "public-profile",
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
    let phase = "tick_export";
    try {
      const client = new MountainProjectClient(this.#fetchFn);
      const csv = await client.getTickExport(tokens.accessToken);
      const decoded = decodeMountainProjectTickExport(csv);
      if (!decoded.ok) throw new Error(`Mountain Project tick export ${decoded.message}.`);
      parsed = parseMountainProjectTicks(decoded.ticks, tokens.accessToken);
      phase = "area_enrichment";
      await enrichMountainProjectAreas(client, parsed.entries);
    } catch (error) {
      if (!(error instanceof MountainProjectTickExportError && error.status === 404)) {
        captureException(error, { tags: { provider: this.id, phase } });
      }
      return {
        provider: this.id,
        recordsSynced,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
        duration: Date.now() - startedAt,
      };
    }

    errors.push(...parsed.errors);

    try {
      recordsSynced = await withSyncLog(
        db,
        this.id,
        "climbing_activity",
        async () =>
          db.transaction(async (transaction) => {
            const result = await persistClimbingLogEntries(transaction, {
              userId,
              providerId: this.id,
              entries: parsed.entries,
            });
            const present = parsed.entries.map((entry) => entry.externalId);
            if (present.length > 0 && parsed.errors.length === 0) {
              const presentIds = sql.join(
                present.map((id) => sql`${id}`),
                sql`, `,
              );
              await transaction.execute(sql`
              UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW()
              WHERE user_id = ${userId} AND provider_id = ${this.id}
                AND provider_absent_at IS NULL AND external_id IS NOT NULL
                AND external_id NOT IN (${presentIds})
            `);
            }
            return { recordCount: result.recordsSynced, result: result.recordsSynced };
          }),
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

/** Resolve the complete source graph before persistence or absence reconciliation. */
async function enrichMountainProjectAreas(
  client: MountainProjectClient,
  entries: MountainProjectLogEntry[],
): Promise<void> {
  const routes = new Map<string, MountainProjectRoute>();
  const areas = new Map<string, MountainProjectArea>();
  for (const entry of entries) {
    const routeId = entry.climb.externalId;
    if (!routeId) continue;
    let route = routes.get(routeId);
    if (!route) {
      route = await client.getRoute(routeId);
      routes.set(routeId, route);
    }
    const chain: MountainProjectArea[] = [];
    const seen = new Set<string>();
    let areaId = route.parent.id;
    while (areaId !== 0) {
      const id = String(areaId);
      if (seen.has(id))
        throw new Error(`Mountain Project Area ancestry contains a cycle at ${id}.`);
      seen.add(id);
      let area = areas.get(id);
      if (!area) {
        area = await client.getArea(id);
        areas.set(id, area);
      }
      chain.push(area);
      areaId = area.parent.id;
    }
    chain.reverse();
    if (chain.length) {
      entry.climb = {
        ...entry.climb,
        areas: chain.map((area) => ({
          externalId: String(area.id),
          name: area.title,
          parentExternalId: area.parent.id === 0 ? null : String(area.parent.id),
          ...(area.coordinates === undefined
            ? {}
            : {
                coordinates:
                  area.coordinates === null
                    ? null
                    : {
                        longitude: area.coordinates[0],
                        latitude: area.coordinates[1],
                      },
              }),
        })),
      };
    }
    entry.raw = {
      ...entry.raw,
      sourceEnrichment: { route: route.raw, areas: chain.map((area) => area.raw) },
    };
  }
}

function parseMountainProjectTicks(
  ticks: MountainProjectTick[],
  profileId: string,
): TickExportParseResult {
  const entries: MountainProjectLogEntry[] = [];
  const occurrenceByFingerprint = new Map<string, number>();
  const errors: SyncError[] = [];
  for (const tick of ticks) {
    const date = tick.date.trim() === "" ? null : parseExportDate(tick.date);
    if (tick.date.trim() !== "" && date === null) {
      errors.push({ message: `Skipped Mountain Project tick with invalid date: ${tick.date}.` });
      continue;
    }
    const dateKey = date?.toISOString().slice(0, 10) ?? null;
    const fingerprint = [dateKey ?? "", tick.url, tick.style, tick.leadStyle, tick.pitches].join(
      "\u001f",
    );
    const occurrence = occurrenceByFingerprint.get(fingerprint) ?? 0;
    occurrenceByFingerprint.set(fingerprint, occurrence + 1);
    const kind = isBoulder(tick) ? "boulder" : "route";
    const methods: Readonly<Record<string, RopeMethod>> = {
      Lead: "lead",
      TR: "top_rope",
      Follow: "follow",
    };
    const resultStyle = kind === "boulder" ? tick.style : tick.leadStyle;
    const qualifier = sourceQualifier(resultStyle, tick.style === "Aid");
    const types = tick.routeType.split(",").map((type) => type.trim().toLowerCase());
    const knownRock =
      kind === "boulder" ||
      types.some((type) => ["sport", "trad", "tr", "top rope"].includes(type));
    const areas = tick.location
      .split(">")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name, externalId: null }));
    entries.push({
      externalId: `mountain-project:tick:${stableHash([fingerprint, String(occurrence)])}`,
      climbedOn: dateKey,
      discipline: knownRock ? "rock_climbing" : null,
      notes: nullableText(tick.notes),
      sourceName: MOUNTAIN_PROJECT_PROVIDER_NAME,
      raw: { ...tick.raw, sourceProfileId: profileId },
      ...(tick.yourRating.trim()
        ? { reportedGrades: parseMountainProjectGrades(tick.yourRating) }
        : {}),
      attempts: [
        {
          scope: "climb",
          ropeMethod: kind === "boulder" ? null : (methods[tick.style] ?? null),
          ...(tick.style === "Solo" ? { solo: true } : {}),
          ...(tick.style === "Aid" ? { usedAid: true } : {}),
          ...(resultStyle.trim().toLowerCase() === "pinkpoint"
            ? { usedPreplacedProtection: true }
            : {}),
          ...(qualifier === undefined ? {} : { qualifier }),
        },
      ],
      climb: {
        externalId: routeIdentity(tick.url),
        name: nullableText(tick.route),
        kind,
        publishedGrades: parseMountainProjectGrades(tick.rating),
        routeProtection: tick.routeType.trim()
          ? types.flatMap((type): ProtectionStyle[] =>
              type === "sport" || type === "trad" ? [type] : [],
            )
          : null,
        ...(areas.length === 0 ? {} : { areas }),
      },
    });
  }
  return { entries, errors };
}

function sourceQualifier(value: string, aid: boolean): SourceClimbingAttempt["qualifier"] {
  switch (value.trim().toLowerCase()) {
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

function routeIdentity(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["mountainproject.com", "www.mountainproject.com"].includes(url.hostname)
  )
    return null;
  return /^\/route\/([1-9]\d*)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
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
