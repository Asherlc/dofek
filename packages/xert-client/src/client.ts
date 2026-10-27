import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import {
  type XertActivity,
  type XertActivityListOptions,
  XertActivityListSchema,
  type XertClientCredentials,
  type XertTokenSet,
} from "./types.ts";

export const XERT_API_BASE_URL = "https://www.xertonline.com";

export const DEFAULT_XERT_CLIENT_CREDENTIALS: Readonly<XertClientCredentials> = Object.freeze({
  clientId: "xert_public",
  clientSecret: "xert_public",
});

const DEFAULT_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

const XertTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export class XertAuthenticationError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;
  readonly operation: "sign-in" | "token refresh";

  constructor(
    operation: "sign-in" | "token refresh",
    statusCode: number,
    responseBody: string,
    options?: ErrorOptions,
  ) {
    super(`Xert ${operation} failed (${statusCode}): ${responseBody}`, options);
    this.name = new.target.name;
    this.operation = operation;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class XertApiError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string, options?: ErrorOptions) {
    super(`Xert API error (${statusCode}): ${responseBody}`, options);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function authorizationHeader(credentials: XertClientCredentials): string {
  return `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`;
}

function parseTokenResponse(
  data: unknown,
  fallbackRefreshToken: string | null = null,
): XertTokenSet {
  const parsed = XertTokenResponseSchema.parse(data);
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? fallbackRefreshToken,
    expiresAt: new Date(Date.now() + (parsed.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000),
    scopes: parsed.scope ?? null,
  };
}

async function requestToken(
  operation: "sign-in" | "token refresh",
  body: URLSearchParams,
  fetchFn: typeof globalThis.fetch,
  credentials: XertClientCredentials,
  fallbackRefreshToken: string | null = null,
): Promise<XertTokenSet> {
  const rateLimitFetchFn = createRateLimitAwareFetch(fetchFn, { providerId: "xert" });
  const response = await rateLimitFetchFn(`${XERT_API_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(credentials),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new XertAuthenticationError(operation, response.status, responseBody);
  }

  const data: unknown = await response.json();
  return parseTokenResponse(data, fallbackRefreshToken);
}

/**
 * Signs in with Xert's documented resource-owner password grant.
 *
 * Credentials are explicit so the library never reads process environment.
 */
export function signInToXert(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  credentials: XertClientCredentials = DEFAULT_XERT_CLIENT_CREDENTIALS,
): Promise<XertTokenSet> {
  return requestToken(
    "sign-in",
    new URLSearchParams({
      grant_type: "password",
      username: email,
      password,
    }),
    fetchFn,
    credentials,
  );
}

/**
 * Exchanges a refresh token for a new token set.
 *
 * Xert normally rotates refresh tokens. If it omits one, this retains the
 * supplied refresh token so callers do not accidentally discard it.
 */
export function refreshXertToken(
  refreshToken: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  credentials: XertClientCredentials = DEFAULT_XERT_CLIENT_CREDENTIALS,
): Promise<XertTokenSet> {
  return requestToken(
    "token refresh",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    fetchFn,
    credentials,
    refreshToken,
  );
}

export class XertClient {
  readonly #accessToken: string;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = createRateLimitAwareFetch(fetchFn, { providerId: "xert" });
  }

  static signIn(
    email: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    credentials: XertClientCredentials = DEFAULT_XERT_CLIENT_CREDENTIALS,
  ): Promise<XertTokenSet> {
    return signInToXert(email, password, fetchFn, credentials);
  }

  static refreshToken(
    refreshToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    credentials: XertClientCredentials = DEFAULT_XERT_CLIENT_CREDENTIALS,
  ): Promise<XertTokenSet> {
    return refreshXertToken(refreshToken, fetchFn, credentials);
  }

  async listActivities(options: XertActivityListOptions): Promise<XertActivity[]> {
    const query = new URLSearchParams({
      from: String(options.from),
      page: String(options.page ?? 0),
      limit: String(options.limit ?? 50),
    });
    const response = await this.#fetchFn(
      `${XERT_API_BASE_URL}/oauth/activity/?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
      throw new XertApiError(response.status, responseBody);
    }

    const data: unknown = await response.json();
    return XertActivityListSchema.parse(data);
  }
}

export type {
  XertActivity,
  XertActivityListOptions,
  XertClientCredentials,
  XertTokenSet,
} from "./types.ts";
