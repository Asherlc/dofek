import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import {
  buildOAuth1FormBody,
  buildOAuth1Header,
  encodeRFC3986,
  type OAuth1Credentials,
} from "./signing.ts";

type FetchFn = typeof globalThis.fetch;

const API_BASE = "https://platform.fatsecret.com/rest/server.api";
const REQUEST_TOKEN_URL = "https://authentication.fatsecret.com/oauth/request_token";
export const AUTHORIZE_URL = "https://authentication.fatsecret.com/oauth/authorize";
export const ACCESS_TOKEN_URL = "https://authentication.fatsecret.com/oauth/access_token";

/**
 * Call a FatSecret REST API method with a signed OAuth 1.0 Authorization header.
 */
export async function fatsecretApi(
  method: string,
  params: Record<string, string>,
  creds: OAuth1Credentials,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<unknown> {
  const rateLimitFetchFn = createProviderRateLimitFetch("fatsecret", fetchFn);
  const allParams = { ...params, method, format: "json" };
  const authHeader = buildOAuth1Header("GET", API_BASE, allParams, creds);

  const queryString = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const response = await rateLimitFetchFn(`${API_BASE}?${queryString}`, {
    method: "GET",
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FatSecret API error (${response.status}): ${text}`);
  }

  return response.json();
}

export interface RequestTokenResult {
  oauthToken: string;
  oauthTokenSecret: string;
  authorizeUrl: string;
}

/**
 * Step 1: Get a request token from FatSecret.
 */
export async function getRequestToken(
  consumerKey: string,
  consumerSecret: string,
  callbackUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<RequestTokenResult> {
  const rateLimitFetchFn = createProviderRateLimitFetch("fatsecret", fetchFn);

  // FatSecret expects the signed OAuth params as the POST body.
  const bodyString = buildOAuth1FormBody(
    REQUEST_TOKEN_URL,
    { oauth_consumer_key: consumerKey, oauth_callback: callbackUrl },
    `${encodeRFC3986(consumerSecret)}&`,
  );

  const response = await rateLimitFetchFn(REQUEST_TOKEN_URL, {
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
export async function exchangeForAccessToken(
  consumerKey: string,
  consumerSecret: string,
  requestToken: string,
  requestTokenSecret: string,
  oauthVerifier: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ token: string; tokenSecret: string }> {
  const rateLimitFetchFn = createProviderRateLimitFetch("fatsecret", fetchFn);

  // FatSecret expects the signed OAuth params as the POST body, not a header.
  const bodyString = buildOAuth1FormBody(
    ACCESS_TOKEN_URL,
    { oauth_consumer_key: consumerKey, oauth_token: requestToken, oauth_verifier: oauthVerifier },
    `${encodeRFC3986(consumerSecret)}&${encodeRFC3986(requestTokenSecret)}`,
  );

  const response = await rateLimitFetchFn(ACCESS_TOKEN_URL, {
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
