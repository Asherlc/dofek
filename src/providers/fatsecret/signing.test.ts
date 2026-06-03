import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOAuth1FormBody,
  buildOAuth1Header,
  encodeRFC3986,
  type OAuth1Credentials,
} from "./signing.ts";

// Independent re-implementation of RFC 3986 encoding so a mutation in the
// production encoder is not mirrored in the expected-signature computation.
function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Independent HMAC-SHA1 signature, mirroring the OAuth 1.0 spec, used to verify
// the production signature exactly (kills sort/uppercase/encoding/`??` mutants).
function expectedSignature(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
  signingKey: string,
): string {
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key] ?? "")}`)
    .join("&");
  const baseString = [method, rfc3986(baseUrl), rfc3986(paramString)].join("&");
  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function parseHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.replace(/^OAuth /, "").split(", ")) {
    const match = part.match(/^([^=]+)="(.*)"$/);
    if (match?.[1]) out[match[1]] = decodeURIComponent(match[2] ?? "");
  }
  return out;
}

function headerKeys(header: string): string[] {
  return header
    .replace(/^OAuth /, "")
    .split(", ")
    .map((part) => part.split("=")[0] ?? "");
}

describe("encodeRFC3986", () => {
  it("percent-encodes the reserved characters !'()* with uppercase hex", () => {
    expect(encodeRFC3986("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("encodes spaces as %20 and leaves unreserved characters untouched", () => {
    expect(encodeRFC3986("a b")).toBe("a%20b");
    expect(encodeRFC3986("plain-Value_1")).toBe("plain-Value_1");
  });
});

describe("buildOAuth1Header", () => {
  const creds: OAuth1Credentials = {
    consumerKey: "my key",
    consumerSecret: "my secret",
    token: "tok!",
    tokenSecret: "ts*",
  };

  it("computes a correct HMAC-SHA1 signature over the sorted base string", () => {
    const params = { method: "food_entries.get.v2", date: "19814" };
    const header = buildOAuth1Header(
      "get", // lowercase on purpose — the signer must uppercase it
      "https://platform.fatsecret.com/rest/server.api?ignored=param",
      params,
      creds,
    );
    const parsed = parseHeader(header);

    const allParams: Record<string, string> = {
      ...params,
      oauth_consumer_key: creds.consumerKey,
      oauth_token: creds.token,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: parsed.oauth_timestamp ?? "",
      oauth_nonce: parsed.oauth_nonce ?? "",
      oauth_version: "1.0",
    };
    const expected = expectedSignature(
      "GET",
      "https://platform.fatsecret.com/rest/server.api",
      allParams,
      `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`,
    );

    expect(parsed.oauth_signature).toBe(expected);
  });

  it("emits the OAuth params in sorted order", () => {
    const header = buildOAuth1Header("GET", "https://example.com/api", { z: "1", a: "2" }, creds);
    const keys = headerKeys(header);
    expect(keys).toEqual([...keys].sort());
  });

  it("uses a unix-seconds timestamp and includes the standard OAuth fields", () => {
    const header = buildOAuth1Header("GET", "https://example.com/api", {}, creds);
    const parsed = parseHeader(header);

    const seconds = Number(parsed.oauth_timestamp);
    const nowSeconds = Date.now() / 1000;
    expect(seconds).toBeGreaterThan(nowSeconds - 60);
    expect(seconds).toBeLessThan(nowSeconds + 60);

    expect(parsed.oauth_consumer_key).toBe(creds.consumerKey);
    expect(parsed.oauth_token).toBe(creds.token);
    expect(parsed.oauth_signature_method).toBe("HMAC-SHA1");
    expect(parsed.oauth_version).toBe("1.0");
    expect(parsed.oauth_nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a fresh nonce on each call", () => {
    const first = parseHeader(buildOAuth1Header("GET", "https://example.com/api", {}, creds));
    const second = parseHeader(buildOAuth1Header("GET", "https://example.com/api", {}, creds));
    expect(first.oauth_nonce).not.toBe(second.oauth_nonce);
  });
});

describe("buildOAuth1FormBody", () => {
  it("returns a sorted, signed, form-encoded body", () => {
    const url = "https://authentication.fatsecret.com/oauth/request_token";
    const signingKey = "consumer-secret&";
    const body = buildOAuth1FormBody(
      url,
      { oauth_consumer_key: "ck", oauth_callback: "http://localhost:9876/cb?x=1" },
      signingKey,
    );
    const params = Object.fromEntries(new URLSearchParams(body));

    const allParams: Record<string, string> = {
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: params.oauth_timestamp ?? "",
      oauth_nonce: params.oauth_nonce ?? "",
      oauth_version: "1.0",
      oauth_consumer_key: "ck",
      oauth_callback: "http://localhost:9876/cb?x=1",
    };
    const expected = expectedSignature("POST", url, allParams, signingKey);

    expect(params.oauth_signature).toBe(expected);

    const keys = body.split("&").map((part) => part.split("=")[0] ?? "");
    expect(keys).toEqual([...keys].sort());
  });

  it("includes the caller-supplied params alongside the standard OAuth fields", () => {
    const body = buildOAuth1FormBody(
      "https://authentication.fatsecret.com/oauth/access_token",
      { oauth_consumer_key: "ck", oauth_token: "req-tok", oauth_verifier: "verifier-9" },
      "secret&token-secret",
    );
    const params = Object.fromEntries(new URLSearchParams(body));
    expect(params.oauth_consumer_key).toBe("ck");
    expect(params.oauth_token).toBe("req-tok");
    expect(params.oauth_verifier).toBe("verifier-9");
    expect(params.oauth_signature_method).toBe("HMAC-SHA1");
    expect(params.oauth_version).toBe("1.0");
  });
});
