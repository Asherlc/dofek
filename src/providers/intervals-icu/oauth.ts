import {
  createRateLimitAwareFetch,
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
  parseRetryAfterHeader,
} from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../../auth/oauth.ts";
import { getOAuthRedirectUri } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { bindProviderSourceAccount } from "../../db/provider-data-deletion.ts";
import {
  ProviderAuthorizationAccountMismatchError,
  ProviderPartialGrantError,
} from "../auth-errors.ts";
import type { ProviderAuthSetup } from "../types.ts";

const INTERVALS_ICU_API_BASE = "https://intervals.icu/api/v1";
const INTERVALS_ICU_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
const INTERVALS_ICU_TOKEN_URL = "https://intervals.icu/api/oauth/token";

const INTERVALS_ICU_REQUIRED_SCOPES = ["ACTIVITY:READ", "WELLNESS:READ", "CALENDAR:READ"] as const;

/** Default expiry when provider omits expires_in (1 year). */
const DEFAULT_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

const athleteSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number().int().positive()]),
  name: z.string().optional(),
});

const intervalsIcuTokenPayloadSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  athlete: athleteSchema,
});

const INTERVALS_ICU_PROVIDER_ID = "intervals.icu";

/** Shared OAuth request helper using rate-limit-aware fetch with call-time globalThis.fetch for MSW compatibility. */
async function oauthRequest(
  operation: "token" | "revoke",
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  // Preserve original error message format for each operation
  const messagePrefix =
    operation === "revoke" ? "Intervals.icu disconnect" : "Intervals.icu token exchange";
  const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
    providerId: INTERVALS_ICU_PROVIDER_ID,
    scope: "provider",
    createRateLimitError: (response, responseBody) =>
      new ProviderRateLimitError({
        message: `${messagePrefix} failed (${response.status})`,
        providerId: INTERVALS_ICU_PROVIDER_ID,
        statusCode: response.status,
        responseBody,
        scope: "provider",
        retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
      }),
    createServiceUnavailableError: (response, responseBody) =>
      new ProviderServiceUnavailableError({
        message: `${messagePrefix} failed (${response.status})`,
        providerId: INTERVALS_ICU_PROVIDER_ID,
        statusCode: response.status,
        responseBody,
        scope: "provider",
        retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
      }),
  });
  return await rateLimitFetch(url, init);
}

/** Binds the Intervals.icu athlete to the user; throws if another athlete's data is retained. */
export async function bindIntervalsIcuAthlete(
  db: SyncDatabase,
  userId: string,
  athleteId: string,
): Promise<void> {
  const bound = await bindProviderSourceAccount(db, userId, INTERVALS_ICU_PROVIDER_ID, athleteId);
  if (!bound)
    throw new ProviderAuthorizationAccountMismatchError(
      "Intervals.icu",
      "To use a different athlete, delete the existing Intervals.icu provider data and wait for the deletion to finish.",
    );
}

export function validateIntervalsIcuConfig(): string | null {
  const clientId = process.env.INTERVALS_ICU_CLIENT_ID?.trim();
  const clientSecret = process.env.INTERVALS_ICU_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return "Missing INTERVALS_ICU_CLIENT_ID or INTERVALS_ICU_CLIENT_SECRET";
  }
  return null;
}

async function revokeIntervalsIcuTokens(tokens: TokenSet): Promise<void> {
  const response = await oauthRequest(
    "revoke",
    globalThis.fetch,
    `${INTERVALS_ICU_API_BASE}/disconnect-app`,
    {
      method: "DELETE",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    },
  );

  // Official API docs (https://intervals.icu/api/v1/docs) document 200 (revoked) and 401 (invalid bearer).
  if (response.status === 200 || response.status === 401) {
    return;
  }

  // Errors are already thrown as ProviderRateLimitError or ProviderServiceUnavailableError
  // from the oauthRequest helper for 429/503. For other statuses, throw with existing message.
  throw new Error(`Intervals.icu disconnect failed (${response.status})`);
}

export function createIntervalsIcuAuthSetup(options?: { host?: string }): ProviderAuthSetup {
  const clientId = process.env.INTERVALS_ICU_CLIENT_ID?.trim();
  const clientSecret = process.env.INTERVALS_ICU_CLIENT_SECRET?.trim();
  const revocation = {
    apiBaseUrl: INTERVALS_ICU_API_BASE,
    revokeExistingTokens: revokeIntervalsIcuTokens,
    revokeTokensForAccountErasure: revokeIntervalsIcuTokens,
  };
  if (!clientId || !clientSecret) return revocation;

  const oauthConfig: OAuthConfig = {
    clientId,
    clientSecret,
    authorizeUrl: INTERVALS_ICU_AUTHORIZE_URL,
    tokenUrl: INTERVALS_ICU_TOKEN_URL,
    redirectUri: getOAuthRedirectUri(options?.host),
    scopes: [...INTERVALS_ICU_REQUIRED_SCOPES],
    scopeSeparator: ",",
    usePkce: true,
  };

  const exchangeCode = async (
    code: string,
    codeVerifier?: string,
    onTokensIssued?: (tokens: TokenSet) => void,
  ): Promise<TokenSet> => {
    if (!codeVerifier?.trim()) {
      throw new Error("Intervals.icu OAuth requires the original PKCE code verifier");
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
    });

    let response: Response;
    try {
      response = await oauthRequest("token", globalThis.fetch, INTERVALS_ICU_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (networkError: unknown) {
      // Preserve existing behavior: only wrap network errors, not HTTP error responses
      if (
        networkError instanceof ProviderRateLimitError ||
        networkError instanceof ProviderServiceUnavailableError
      ) {
        throw networkError;
      }
      throw new Error("Intervals.icu token exchange network request failed", {
        cause: networkError,
      });
    }

    if (!response.ok) {
      throw new Error(`Intervals.icu token exchange failed (${response.status})`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error("Intervals.icu returned a malformed token response");
    }

    const parsed = intervalsIcuTokenPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      const athleteIssue = parsed.error.issues.some((issue) => issue.path[0] === "athlete");
      if (athleteIssue) {
        throw new Error("Intervals.icu token response is missing athlete information");
      }
      throw new Error("Intervals.icu returned a malformed token response");
    }

    const athleteId =
      typeof parsed.data.athlete.id === "number"
        ? parsed.data.athlete.id.toString()
        : parsed.data.athlete.id;

    const rawScope = parsed.data.scope ?? "";
    const grantedScopes = new Set(
      rawScope
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    // Intervals.icu: same-category WRITE implies READ (Update checkbox returns WRITE).
    // https://forum.intervals.icu/t/intervals-icu-oauth-support/2759
    const missingScopes = INTERVALS_ICU_REQUIRED_SCOPES.filter(
      (scope) => !grantedScopes.has(scope) && !grantedScopes.has(scope.replace(":READ", ":WRITE")),
    );
    if (missingScopes.length > 0) {
      throw new ProviderPartialGrantError("Intervals.icu", missingScopes);
    }

    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000);

    const tokens: TokenSet = {
      accessToken: parsed.data.access_token,
      refreshToken: null,
      expiresAt,
      scopes: parsed.data.scope ?? null,
      providerAccountId: athleteId,
    };

    onTokensIssued?.(tokens);
    return tokens;
  };

  return {
    ...revocation,
    oauthConfig,
    reconnectStrategy: "replace",
    assertCanConnect: async (db, userId, tokens) => {
      const athleteId = tokens.providerAccountId?.trim();
      if (!athleteId) throw new Error("Intervals.icu connection requires its athlete ID");
      await bindIntervalsIcuAthlete(db, userId, athleteId);
    },
    exchangeCode,
  };
}
