import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getOAuthRedirectUri } from "../../auth/oauth.ts";
import { nutrientAmountEntriesFromLegacyFields } from "../../db/nutrient-columns.ts";
import { foodEntry, foodEntryNutrient } from "../../db/schema/nutrition.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { logger } from "../../logger.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncError, SyncProvider, SyncResult } from "../types.ts";
import {
  ACCESS_TOKEN_URL,
  AUTHORIZE_URL,
  exchangeForAccessToken,
  fatsecretApi,
  getRequestToken,
} from "./client.ts";
import { fatSecretFoodEntriesResponseSchema, inferCategory, parseFoodEntries } from "./parsing.ts";
import type { OAuth1Credentials } from "./signing.ts";

type FetchFn = typeof globalThis.fetch;

// ============================================================
// Provider
// ============================================================

export class FatSecretProvider implements SyncProvider {
  readonly id = "fatsecret";
  readonly name = "FatSecret";

  #consumerKey: string | null;
  #consumerSecret: string | null;
  #fetchFn: FetchFn;

  constructor(fetchFn: FetchFn = globalThis.fetch) {
    this.#consumerKey = process.env.FATSECRET_CONSUMER_KEY ?? null;
    this.#consumerSecret = process.env.FATSECRET_CONSUMER_SECRET ?? null;
    this.#fetchFn = createProviderRateLimitFetch("fatsecret", fetchFn);
  }

  validate(): string | null {
    if (!this.#consumerKey) return "FATSECRET_CONSUMER_KEY is not set";
    if (!this.#consumerSecret) return "FATSECRET_CONSUMER_SECRET is not set";
    return null;
  }

  #getCredentials(): { consumerKey: string; consumerSecret: string } {
    const validation = this.validate();
    if (validation !== null) {
      throw new Error("FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET are required");
    }
    const consumerKey = this.#consumerKey;
    const consumerSecret = this.#consumerSecret;

    if (!consumerKey || !consumerSecret) {
      throw new Error("FatSecret credentials are not configured");
    }
    return {
      consumerKey,
      consumerSecret,
    };
  }

  /**
   * FatSecret uses OAuth 1.0 3-legged flow.
   * We store the access token as accessToken and token secret as refreshToken
   * in the existing oauthToken table (OAuth 1.0 tokens don't expire).
   */
  authSetup(options?: { host?: string }) {
    const { consumerKey, consumerSecret } = this.#getCredentials();
    const fetchFn = this.#fetchFn;

    return {
      // OAuth 1.0 uses a different flow, but we provide these for CLI compatibility
      oauthConfig: {
        clientId: consumerKey,
        clientSecret: consumerSecret,
        authorizeUrl: AUTHORIZE_URL,
        tokenUrl: ACCESS_TOKEN_URL,
        redirectUri: getOAuthRedirectUri(options?.host),
        scopes: [],
      },
      oauth1Flow: {
        getRequestToken: (callbackUrl: string) =>
          getRequestToken(consumerKey, consumerSecret, callbackUrl, fetchFn),
        exchangeForAccessToken: (
          requestToken: string,
          requestTokenSecret: string,
          oauthVerifier: string,
        ) =>
          exchangeForAccessToken(
            consumerKey,
            consumerSecret,
            requestToken,
            requestTokenSecret,
            oauthVerifier,
            fetchFn,
          ),
      },
      exchangeCode: async (_code: string) => {
        throw new Error("FatSecret uses OAuth 1.0 — use oauth1Flow instead");
      },
    };
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window } = run;
    const since = window.since;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;
    const scopedUserId = getTokenUserId();
    if (!scopedUserId) {
      throw new Error("fatsecret sync requires user context");
    }

    await ensureProvider(db, this.id, this.name);

    // Load stored OAuth 1.0 tokens
    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "No OAuth tokens found — run 'auth fatsecret' first" }],
        duration: Date.now() - start,
      };
    }

    if (!tokens.refreshToken) throw new Error("No token secret stored for FatSecret");
    const { consumerKey, consumerSecret } = this.#getCredentials();
    const creds: OAuth1Credentials = {
      consumerKey,
      consumerSecret,
      token: tokens.accessToken,
      tokenSecret: tokens.refreshToken, // OAuth 1.0 token secret stored as refreshToken
    };

    // Iterate day-by-day from `since` to today
    const today = new Date();
    const current = new Date(since);
    current.setUTCHours(0, 0, 0, 0);

    // Cap lookback to 2 years — FatSecret syncs day-by-day, so unbounded ranges
    // generate thousands of API calls for empty days
    const maxLookback = new Date();
    maxLookback.setFullYear(maxLookback.getFullYear() - 2);
    maxLookback.setUTCHours(0, 0, 0, 0);
    if (current < maxLookback) {
      current.setTime(maxLookback.getTime());
    }

    while (current <= today) {
      const dateInt = Math.floor(current.getTime() / 86400000).toString();

      try {
        const rawResponse = await fatsecretApi(
          "food_entries.get.v2",
          { date: dateInt },
          creds,
          this.#fetchFn,
        );
        const response = fatSecretFoodEntriesResponseSchema.parse(rawResponse);

        const entries = parseFoodEntries(response);

        if (entries.length > 0) {
          for (const e of entries) {
            // Skip if food_entry already exists.
            const existing = await db
              .select({ id: foodEntry.id })
              .from(foodEntry)
              .where(
                sql`${foodEntry.userId} = ${scopedUserId} AND ${foodEntry.providerId} = ${this.id} AND ${foodEntry.externalId} = ${e.externalId}`,
              );
            if (existing.length > 0) continue;

            // Insert food_entry + nutrition for new entries
            const [foodEntryRow] = await db
              .insert(foodEntry)
              .values({
                providerId: this.id,
                externalId: e.externalId,
                date: e.date,
                nutritionGrain: "itemized",
                meal: e.meal,
                foodName: e.foodName,
                foodDescription: e.foodDescription,
                category: inferCategory(e.foodName),
                providerFoodId: e.fatsecretFoodId,
                providerServingId: e.fatsecretServingId,
                numberOfUnits: e.numberOfUnits,
                raw: { ...e },
              })
              .onConflictDoNothing()
              .returning({ id: foodEntry.id });
            if (foodEntryRow?.id) {
              const nutrientEntries = nutrientAmountEntriesFromLegacyFields({
                calories: e.calories,
                proteinG: e.proteinG,
                carbsG: e.carbsG,
                fatG: e.fatG,
                saturatedFatG: e.saturatedFatG,
                polyunsaturatedFatG: e.polyunsaturatedFatG,
                monounsaturatedFatG: e.monounsaturatedFatG,
                cholesterolMg: e.cholesterolMg,
                sodiumMg: e.sodiumMg,
                potassiumMg: e.potassiumMg,
                fiberG: e.fiberG,
                sugarG: e.sugarG,
                vitaminAMcg: e.vitaminAMcg,
                vitaminCMg: e.vitaminCMg,
                calciumMg: e.calciumMg,
                ironMg: e.ironMg,
              });
              if (nutrientEntries.length > 0) {
                await db.insert(foodEntryNutrient).values(
                  nutrientEntries.map((nutrientEntry) => ({
                    foodEntryId: foodEntryRow.id,
                    nutrientId: nutrientEntry.nutrientId,
                    amount: nutrientEntry.amount,
                  })),
                );
              }
            }
          }
          recordsSynced += entries.length;
        }
      } catch (err) {
        // Let rate-limit errors propagate so the cooldown/retry pipeline can handle them.
        if (err instanceof ProviderRateLimitError) throw err;

        // FatSecret returns an error for days with no entries — not a real error.
        // The API may return "No entries found" (HTTP error) or an unexpected response
        // shape that fails Zod validation on the food_entries key (empty day variant).
        const isNoEntriesMessage = err instanceof Error && err.message.includes("No entries found");
        const isFoodEntriesZodError =
          err instanceof z.ZodError && err.issues.some((issue) => issue.path[0] === "food_entries");
        if (!isNoEntriesMessage && !isFoodEntriesZodError) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ message: `Date ${current.toISOString().split("T")[0]}: ${msg}` });
        }
      }

      current.setDate(current.getDate() + 1);
    }

    logger.info(`[fatsecret] ${recordsSynced} food entries synced`);

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
