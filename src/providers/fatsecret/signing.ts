import { createHmac, randomBytes } from "node:crypto";

// ============================================================
// OAuth 1.0 HMAC-SHA1 signing (FatSecret)
// ============================================================

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/**
 * RFC 3986 percent-encoding (stricter than encodeURIComponent).
 */
export function encodeRFC3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Compute the OAuth 1.0 HMAC-SHA1 signature for a request.
 *
 * The signature base string is `METHOD&encoded-base-url&encoded-sorted-params`,
 * signed with `encoded-consumer-secret&encoded-token-secret`.
 */
function computeSignature(
  method: string,
  url: string,
  signedParams: Record<string, string>,
  signingKey: string,
): string {
  const paramString = Object.keys(signedParams)
    .sort()
    .map((key) => `${encodeRFC3986(key)}=${encodeRFC3986(signedParams[key] ?? "")}`)
    .join("&");

  const parsedUrl = new URL(url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

  const baseString = [
    method.toUpperCase(),
    encodeRFC3986(baseUrl),
    encodeRFC3986(paramString),
  ].join("&");

  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function standardOAuthParams(extra: Record<string, string>): Record<string, string> {
  return {
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
    ...extra,
  };
}

/**
 * Build an OAuth 1.0 `Authorization` header with HMAC-SHA1 signature.
 * Used for two-legged signed API requests (consumer + access token).
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: OAuth1Credentials,
): string {
  const oauthParams = standardOAuthParams({
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.token,
  });

  const signingKey = `${encodeRFC3986(creds.consumerSecret)}&${encodeRFC3986(creds.tokenSecret)}`;
  oauthParams.oauth_signature = computeSignature(
    method,
    url,
    { ...params, ...oauthParams },
    signingKey,
  );

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((key) => `${key}="${encodeRFC3986(oauthParams[key] ?? "")}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

/**
 * Sign OAuth 1.0 params for a `POST` token-endpoint request and return them as
 * a urlencoded form body. FatSecret's request-token and access-token endpoints
 * expect the OAuth params in the body rather than an `Authorization` header.
 *
 * Standard params (signature method, timestamp, nonce, version) are added
 * automatically; pass the request-specific params (consumer key, callback,
 * token, verifier) in `params`.
 */
export function buildOAuth1FormBody(
  url: string,
  params: Record<string, string>,
  signingKey: string,
): string {
  const oauthParams = standardOAuthParams(params);
  oauthParams.oauth_signature = computeSignature("POST", url, oauthParams, signingKey);

  return Object.keys(oauthParams)
    .sort()
    .map((key) => `${encodeRFC3986(key)}=${encodeRFC3986(oauthParams[key] ?? "")}`)
    .join("&");
}
