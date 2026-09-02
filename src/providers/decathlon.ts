import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Decathlon API types
// ============================================================

const DECATHLON_API_BASE = "https://api.decathlon.net/sportstrackingdata/v2";
const _DEFAULT_REDIRECT_URI = "https://localhost:9876/callback";

const parseableIsoDateTimeSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO datetime");

const decathlonDataSummarySchema = z.object({
  id: z.number(),
  value: z.number(),
});

const decathlonActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  sport: z.string(),
  startdate: parseableIsoDateTimeSchema,
  duration: z.number(),
  dataSummaries: z.array(decathlonDataSummarySchema).optional().default([]),
});

type DecathlonActivity = z.infer<typeof decathlonActivitySchema>;

const decathlonActivitiesResponseSchema = z.object({
  data: z.preprocess((value) => value ?? [], z.array(decathlonActivitySchema)),
  links: z
    .object({
      next: z.string().optional(),
    })
    .optional(),
});

// ============================================================
// Parsed types
// ============================================================

export interface ParsedDecathlonActivity {
  externalId: string;
  activityType: ProviderActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Sport type mapping
// ============================================================

// Decathlon sport IDs mapped to normalized activity types
const DECATHLON_SPORT_MAP: Record<string, LegacyActivityType> = {
  "381": "running",
  "121": "cycling",
  "153": "mountain_biking",
  "320": "walking",
  "110": "hiking",
  "274": "trail_running",
  "260": "swimming",
  "79": "cross_country_skiing",
  "173": "rowing",
  "263": "open_water_swimming",
  "91": "skiing",
  "174": "rowing",
  "395": "yoga",
  "105": "gym",
  "264": "triathlon",
  "292": "skating",
  "160": "climbing",
  "100": "cross_training",
  "367": "elliptical",
  "176": "strength_training",
};

export function mapDecathlonSport(sportUri: string): ProviderActivityType {
  // Sport URI is like "/v2/sports/381" — extract the ID
  const sportId = sportUri.split("/").pop() ?? sportUri;
  return resolveProviderActivityType(
    sportUri.trim() || "other",
    DECATHLON_SPORT_MAP[sportId] ?? "other",
  );
}

export function parseDecathlonActivity(act: DecathlonActivity): ParsedDecathlonActivity {
  const startedAt = new Date(act.startdate);
  const endedAt = new Date(startedAt.getTime() + act.duration * 1000);

  const summaries: Record<string, number> = {};
  for (const summary of act.dataSummaries ?? []) {
    summaries[String(summary.id)] = summary.value;
  }

  return {
    externalId: String(act.id),
    activityType: mapDecathlonSport(act.sport),
    name: act.name,
    startedAt,
    endedAt,
    raw: {
      sport: act.sport,
      duration: act.duration,
      distanceKm: summaries["5"],
      avgHeartRate: summaries["1"],
      maxHeartRate: summaries["2"],
      dataSummaries: act.dataSummaries,
    },
  };
}

// ============================================================
// OAuth configuration
// ============================================================

export function decathlonOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.DECATHLON_CLIENT_ID;
  const clientSecret = process.env.DECATHLON_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://api.decathlon.net/connect/oauth/authorize",
    tokenUrl: "https://api.decathlon.net/connect/oauth/token",
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["openid", "profile"],
  };
}

// ============================================================
// Provider implementation
// ============================================================

export class DecathlonProvider implements SyncProvider {
  readonly id = "decathlon";
  readonly name = "Decathlon";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("decathlon", fetchFn);
  }

  validate(): string | null {
    if (!process.env.DECATHLON_CLIENT_ID) return "DECATHLON_CLIENT_ID is not set";
    if (!process.env.DECATHLON_CLIENT_SECRET) return "DECATHLON_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.decathlon.com/sports-tracking/activity/${externalId}`;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = decathlonOAuthConfig(options?.host);
    if (!config) throw new Error("DECATHLON_CLIENT_ID and CLIENT_SECRET required");
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: DECATHLON_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => decathlonOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, DECATHLON_API_BASE);

    let accessToken: string;
    try {
      const tokens = await this.#resolveTokens(db);
      accessToken = tokens.accessToken;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const clientId = process.env.DECATHLON_CLIENT_ID;
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();

    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          const initialUrl = `${DECATHLON_API_BASE}/activities?after=${since.toISOString()}&limit=50`;

          const pages = await fetchProviderPages<DecathlonActivity, string>({
            providerId: this.id,
            stepName: "activity",
            initialCursor: initialUrl,
            fetchPage: async (url) => {
              if (!url) throw new Error("Decathlon pagination missing page URL");
              const response = await this.#fetchFn(url, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                  ...(clientId ? { "x-api-key": clientId } : {}),
                },
              });
              if (!response.ok) {
                const text = await response.text();
                throw new Error(`Decathlon API error (${response.status}): ${text}`);
              }
              const data = decathlonActivitiesResponseSchema.parse(await response.json());
              return {
                items: data.data,
                nextCursor: data.links?.next ?? null,
              };
            },
          });

          for (const raw of pages.items) {
            const parsed = parseDecathlonActivity(raw);
            if (parsed.startedAt.getTime() > syncWindowEnd.getTime()) {
              continue;
            }
            presentActivityExternalIds.add(parsed.externalId);
            try {
              await upsertProviderActivity(
                db,
                {
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
                },
                {
                  activityType: parsed.activityType,
                  name: parsed.name,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: parsed.raw,
                },
              );
              count++;
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId: parsed.externalId,
                cause: err,
              });
            }
          }

          if (pages.degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          return { recordCount: count, result: count, degradations: pages.degradations };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
