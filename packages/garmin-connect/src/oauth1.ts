/**
 * Minimal OAuth 1.0a implementation for Garmin Connect authentication.
 *
 * Only used for two requests in the auth flow:
 * 1. Getting an OAuth1 token from the SSO ticket
 * 2. Exchanging OAuth1 token for OAuth2 token
 *
 * All subsequent API calls use standard OAuth2 Bearer tokens.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { OAuth1Token, OAuthConsumer } from "./types.ts";

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function buildBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? "")}`)
    .join("&");

  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
}

function signHmacSha1(baseString: string, signingKey: string): string {
  return createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
}

export function buildOAuth1Header(
  method: string,
  url: string,
  consumer: OAuthConsumer,
  token?: OAuth1Token,
  extraParams?: Record<string, string>,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumer.consumer_key,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_version: "1.0",
  };

  if (token) {
    oauthParams.oauth_token = token.oauth_token;
  }

  // Combine all params for base string
  const allParams = { ...oauthParams, ...(extraParams ?? {}) };

  // Strip query string from URL for base string calculation
  const urlObj = new URL(url);
  for (const [key, value] of urlObj.searchParams.entries()) {
    allParams[key] = value;
  }
  const baseUrl = `${urlObj.origin}${urlObj.pathname}`;

  const baseString = buildBaseString(method, baseUrl, allParams);

  const signingKey = `${percentEncode(consumer.consumer_secret)}&${
    token ? percentEncode(token.oauth_token_secret) : ""
  }`;

  oauthParams.oauth_signature = signHmacSha1(baseString, signingKey);

  // Build Authorization header
  const headerParams = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key] ?? "")}"`)
    .join(", ");

  return `OAuth ${headerParams}`;
}
