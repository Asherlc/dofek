import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { getOAuthRedirectUri } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { foodEntry } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type { SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// OAuth 1.0 HMAC-SHA1 signing
// ============================================================

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/**
 * Build an OAuth 1.0 Authorization header with HMAC-SHA1 signature.
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: OAuth1Credentials,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.token,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };

  // Combine all params for signature base string
  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(allParams[k] ?? "")}`)
    .join("&");

  // Parse URL to get base URL without query string
  const parsedUrl = new URL(url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

  const baseString = [
    method.toUpperCase(),
    encodeRFC3986(baseUrl),
    encodeRFC3986(paramString),
  ].join("&");

  const signingKey = `${encodeRFC3986(creds.consumerSecret)}&${encodeRFC3986(creds.tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${k}="${encodeRFC3986(oauthParams[k] ?? "")}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

/**
 * RFC 3986 percent-encoding (stricter than encodeURIComponent).
 */
function encodeRFC3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// ============================================================
// FatSecret API types
// ============================================================

export interface FatSecretFoodEntry {
  food_entry_id: string;
  food_entry_name: string;
  food_entry_description: string;
  food_id: string;
  serving_id: string;
  number_of_units: string;
  meal: string;
  date_int: string;
  calories: string;
  carbohydrate: string;
  protein: string;
  fat: string;
  saturated_fat?: string;
  polyunsaturated_fat?: string;
  monounsaturated_fat?: string;
  cholesterol?: string;
  sodium?: string;
  potassium?: string;
  fiber?: string;
  sugar?: string;
  vitamin_a?: string;
  vitamin_c?: string;
  calcium?: string;
  iron?: string;
}

export interface FatSecretFoodEntriesResponse {
  food_entries?: {
    food_entry: FatSecretFoodEntry[];
  } | null;
}

export const fatSecretFoodEntriesResponseSchema = z.object({
  food_entries: z
    .object({
      food_entry: z.array(
        z.object({
          food_entry_id: z.string(),
          food_entry_name: z.string(),
          food_entry_description: z.string(),
          food_id: z.string(),
          serving_id: z.string(),
          number_of_units: z.string(),
          meal: z.string(),
          date_int: z.string(),
          calories: z.string(),
          carbohydrate: z.string(),
          protein: z.string(),
          fat: z.string(),
          saturated_fat: z.string().optional(),
          polyunsaturated_fat: z.string().optional(),
          monounsaturated_fat: z.string().optional(),
          cholesterol: z.string().optional(),
          sodium: z.string().optional(),
          potassium: z.string().optional(),
          fiber: z.string().optional(),
          sugar: z.string().optional(),
          vitamin_a: z.string().optional(),
          vitamin_c: z.string().optional(),
          calcium: z.string().optional(),
          iron: z.string().optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
});

// ============================================================
// Parsed types
// ============================================================

type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export interface ParsedFoodEntry {
  externalId: string;
  foodName: string;
  foodDescription: string;
  fatsecretFoodId: string;
  fatsecretServingId: string;
  numberOfUnits: number;
  meal: MealType;
  date: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  saturatedFatG?: number;
  polyunsaturatedFatG?: number;
  monounsaturatedFatG?: number;
  cholesterolMg?: number;
  sodiumMg?: number;
  potassiumMg?: number;
  fiberG?: number;
  sugarG?: number;
  vitaminAMcg?: number;
  vitaminCMg?: number;
  calciumMg?: number;
  ironMg?: number;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Convert FatSecret date_int (days since epoch) to ISO date string.
 */
function dateIntToIso(dateInt: string): string {
  const days = parseInt(dateInt, 10);
  const ms = days * 86400000; // days * 24h * 60m * 60s * 1000ms
  return new Date(ms).toISOString().split("T")[0] ?? "";
}

/**
 * Parse an optional numeric string — returns undefined if missing.
 */
function optNum(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = parseFloat(val);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Normalize FatSecret meal name to lowercase enum value.
 */
function normalizeMeal(meal: string): MealType {
  const lower = meal.toLowerCase();
  if (lower === "breakfast" || lower === "lunch" || lower === "dinner" || lower === "snack") {
    return lower;
  }
  return "other";
}

// ============================================================
// Category inference (keyword heuristic)
// ============================================================

const SUPPLEMENT_KEYWORDS = [
  "vitamin",
  "multivitamin",
  "supplement",
  "capsule",
  "capsules",
  "tablet",
  "tablets",
  "softgel",
  "softgels",
  "fish oil",
  "omega-3",
  "omega 3",
  "creatine",
  "collagen",
  "probiotic",
  "prebiotic",
  "magnesium",
  "zinc",
  "iron supplement",
  "calcium supplement",
  "ashwagandha",
  "turmeric",
  "curcumin",
  "melatonin",
  "coq10",
  "whey protein",
  "casein protein",
  "protein powder",
  "bcaa",
  "glutamine",
  "electrolyte",
  "extract",
];

/**
 * Dosage pattern: matches "200mg", "1000mcg", "5000IU", "500 mg", etc.
 */
const DOSAGE_PATTERN = /\b\d+\s*(?:mg|mcg|iu|µg)\b/i;

/**
 * Infer food category from the food entry name using keyword heuristics.
 * Returns "supplement" if the name matches supplement patterns, undefined otherwise.
 * This is a best-effort heuristic — API-based category enrichment (Premier tier) is more accurate.
 */
export function inferCategory(foodName: string): "supplement" | undefined {
  const lower = foodName.toLowerCase();

  // Check keyword matches
  for (const keyword of SUPPLEMENT_KEYWORDS) {
    if (lower.includes(keyword)) return "supplement";
  }

  // Check dosage patterns (e.g., "200mg", "5000IU") — strong supplement signal
  if (DOSAGE_PATTERN.test(foodName)) return "supplement";

  return undefined;
}

/**
 * Parse FatSecret food_entries.get response into ParsedFoodEntry array.
 */
export function parseFoodEntries(response: FatSecretFoodEntriesResponse): ParsedFoodEntry[] {
  const entries = response.food_entries?.food_entry;
  if (!entries || entries.length === 0) return [];

  return entries.map((e) => ({
    externalId: e.food_entry_id,
    foodName: e.food_entry_name,
    foodDescription: e.food_entry_description,
    fatsecretFoodId: e.food_id,
    fatsecretServingId: e.serving_id,
    numberOfUnits: parseFloat(e.number_of_units),
    meal: normalizeMeal(e.meal),
    date: dateIntToIso(e.date_int),
    calories: parseInt(e.calories, 10),
    proteinG: parseFloat(e.protein),
    carbsG: parseFloat(e.carbohydrate),
    fatG: parseFloat(e.fat),
    saturatedFatG: optNum(e.saturated_fat),
    polyunsaturatedFatG: optNum(e.polyunsaturated_fat),
    monounsaturatedFatG: optNum(e.monounsaturated_fat),
    cholesterolMg: optNum(e.cholesterol),
    sodiumMg: optNum(e.sodium),
    potassiumMg: optNum(e.potassium),
    fiberG: optNum(e.fiber),
    sugarG: optNum(e.sugar),
    vitaminAMcg: optNum(e.vitamin_a),
    vitaminCMg: optNum(e.vitamin_c),
    calciumMg: optNum(e.calcium),
    ironMg: optNum(e.iron),
  }));
}

// ============================================================
// API client
// ============================================================

const API_BASE = "https://platform.fatsecret.com/rest/server.api";

type FetchFn = typeof globalThis.fetch;

async function fatsecretApi(
  method: string,
  params: Record<string, string>,
  creds: OAuth1Credentials,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<unknown> {
  const allParams = { ...params, method, format: "json" };
  const authHeader = buildOAuth1Header("GET", API_BASE, allParams, creds);

  const queryString = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const response = await fetchFn(`${API_BASE}?${queryString}`, {
    method: "GET",
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FatSecret API error (${response.status}): ${text}`);
  }

  return response.json();
}

// ============================================================
// 3-legged OAuth 1.0 flow
// ============================================================

const REQUEST_TOKEN_URL = "https://authentication.fatsecret.com/oauth/request_token";
const AUTHORIZE_URL = "https://authentication.fatsecret.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://authentication.fatsecret.com/oauth/access_token";

interface RequestTokenResult {
  oauthToken: string;
  oauthTokenSecret: string;
  authorizeUrl: string;
}

/**
 * Step 1: Get a request token from FatSecret.
 */
async function getRequestToken(
  consumerKey: string,
  consumerSecret: string,
  callbackUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<RequestTokenResult> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
    oauth_callback: callbackUrl,
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(oauthParams[k] ?? "")}`)
    .join("&");

  const baseString = ["POST", encodeRFC3986(REQUEST_TOKEN_URL), encodeRFC3986(paramString)].join(
    "&",
  );

  const signingKey = `${encodeRFC3986(consumerSecret)}&`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  // FatSecret expects OAuth params as POST body
  const bodyString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(oauthParams[k] ?? "")}`)
    .join("&");

  const response = await fetchFn(REQUEST_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyString,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FatSecret request token failed (${response.status}): ${text}`);
  }

  const body = await response.text();
  const parsed = new URLSearchParams(body);
  const oauthToken = parsed.get("oauth_token");
  const oauthTokenSecret = parsed.get("oauth_token_secret");

  if (!oauthToken || !oauthTokenSecret) {
    throw new Error(`Invalid request token response: ${body}`);
  }

  return {
    oauthToken,
    oauthTokenSecret,
    authorizeUrl: `${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(oauthToken)}`,
  };
}

/**
 * Step 3: Exchange the authorized request token for an access token.
 */
async function exchangeForAccessToken(
  consumerKey: string,
  consumerSecret: string,
  requestToken: string,
  requestTokenSecret: string,
  oauthVerifier: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ token: string; tokenSecret: string }> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_token: requestToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
    oauth_verifier: oauthVerifier,
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(oauthParams[k] ?? "")}`)
    .join("&");

  const baseString = ["POST", encodeRFC3986(ACCESS_TOKEN_URL), encodeRFC3986(paramString)].join(
    "&",
  );

  const signingKey = `${encodeRFC3986(consumerSecret)}&${encodeRFC3986(requestTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  // FatSecret expects OAuth params as POST body, not Authorization header
  const bodyString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(oauthParams[k] ?? "")}`)
    .join("&");

  const response = await fetchFn(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyString,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FatSecret access token exchange failed (${response.status}): ${text}`);
  }

  const body = await response.text();
  const parsed = new URLSearchParams(body);
  const token = parsed.get("oauth_token");
  const tokenSecret = parsed.get("oauth_token_secret");

  if (!token || !tokenSecret) {
    throw new Error(`Invalid access token response: ${body}`);
  }

  return { token, tokenSecret };
}

// ============================================================
// Provider
// ============================================================

export class FatSecretProvider implements SyncProvider {
  readonly id = "fatsecret";
  readonly name = "FatSecret";

  private consumerKey: string;
  private consumerSecret: string;
  private fetchFn: FetchFn;

  constructor(fetchFn: FetchFn = globalThis.fetch) {
    const consumerKey = process.env.FATSECRET_CONSUMER_KEY;
    const consumerSecret = process.env.FATSECRET_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) {
      throw new Error("FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET are required");
    }
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  /**
   * FatSecret uses OAuth 1.0 3-legged flow.
   * We store the access token as accessToken and token secret as refreshToken
   * in the existing oauthToken table (OAuth 1.0 tokens don't expire).
   */
  authSetup() {
    const consumerKey = this.consumerKey;
    const consumerSecret = this.consumerSecret;
    const fetchFn = this.fetchFn;

    return {
      // OAuth 1.0 uses a different flow, but we provide these for CLI compatibility
      oauthConfig: {
        clientId: consumerKey,
        clientSecret: consumerSecret,
        authorizeUrl: AUTHORIZE_URL,
        tokenUrl: ACCESS_TOKEN_URL,
        redirectUri: getOAuthRedirectUri(),
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

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name);

    // Load stored OAuth 1.0 tokens
    const { loadTokens } = await import("../db/tokens.ts");
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
    const creds: OAuth1Credentials = {
      consumerKey: this.consumerKey,
      consumerSecret: this.consumerSecret,
      token: tokens.accessToken,
      tokenSecret: tokens.refreshToken, // OAuth 1.0 token secret stored as refreshToken
    };

    // Iterate day-by-day from `since` to today
    const today = new Date();
    const current = new Date(since);
    current.setHours(0, 0, 0, 0);

    while (current <= today) {
      const dateInt = Math.floor(current.getTime() / 86400000).toString();

      try {
        const rawResponse = await fatsecretApi(
          "food_entries.get.v2",
          { date: dateInt },
          creds,
          this.fetchFn,
        );
        const response = fatSecretFoodEntriesResponseSchema.parse(rawResponse);

        const entries = parseFoodEntries(response);

        if (entries.length > 0) {
          const rows = entries.map((e) => ({
            providerId: this.id,
            externalId: e.externalId,
            date: e.date,
            meal: e.meal,
            foodName: e.foodName,
            foodDescription: e.foodDescription,
            category: inferCategory(e.foodName),
            providerFoodId: e.fatsecretFoodId,
            providerServingId: e.fatsecretServingId,
            numberOfUnits: e.numberOfUnits,
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
            raw: { ...e },
          }));

          await db.insert(foodEntry).values(rows).onConflictDoNothing();
          recordsSynced += rows.length;
        }
      } catch (err) {
        // FatSecret returns an error for days with no entries — not a real error
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("No entries found")) {
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
