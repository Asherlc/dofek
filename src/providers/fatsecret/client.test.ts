import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import { exchangeForAccessToken, fatsecretApi, getRequestToken } from "./client.ts";
import type { OAuth1Credentials } from "./signing.ts";

const creds: OAuth1Credentials = {
  consumerKey: "ck",
  consumerSecret: "cs",
  token: "tok",
  tokenSecret: "ts",
};

describe("fatsecretApi", () => {
  it("sends a signed GET with the method, format, and params in the query string", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await fatsecretApi("food_entries.get.v2", { date: "19814" }, creds, mockFetch);

    expect(result).toEqual({ ok: true });
    expect(capturedUrl.startsWith("https://platform.fatsecret.com/rest/server.api?")).toBe(true);
    expect(capturedUrl).toContain("method=food_entries.get.v2");
    expect(capturedUrl).toContain("format=json");
    expect(capturedUrl).toContain("date=19814");
    expect(capturedInit?.method).toBe("GET");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toMatch(/^OAuth /);
    expect(headers.get("Authorization")).toContain("oauth_signature=");
  });

  it("throws a labelled error on a non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("server boom", { status: 500 });
    await expect(fatsecretApi("food.get", {}, creds, mockFetch)).rejects.toThrow(
      "FatSecret API error (500): server boom",
    );
  });

  it("surfaces the shared rate-limit error when throttled", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "90" } });

    const error = await fatsecretApi("food.get", {}, creds, mockFetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ providerId: "fatsecret", retryAfterSeconds: 90 });
  });
});

describe("getRequestToken", () => {
  it("posts a signed form body with the consumer key and callback, and returns the token", async () => {
    let capturedInit: RequestInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return new Response("oauth_token=req-token&oauth_token_secret=req-secret", { status: 200 });
    };

    const result = await getRequestToken("ck", "cs", "http://localhost:9876/cb", mockFetch);

    expect(result.oauthToken).toBe("req-token");
    expect(result.oauthTokenSecret).toBe("req-secret");
    expect(result.authorizeUrl).toContain("oauth_token=req-token");

    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = Object.fromEntries(new URLSearchParams(String(capturedInit?.body)));
    expect(body.oauth_consumer_key).toBe("ck");
    expect(body.oauth_callback).toBe("http://localhost:9876/cb");
    expect(body.oauth_signature).toBeTruthy();
  });

  it("throws on a non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => new Response("nope", { status: 401 });
    await expect(getRequestToken("ck", "cs", "http://cb", mockFetch)).rejects.toThrow(
      "FatSecret request token failed (401)",
    );
  });

  it("throws when the token payload is incomplete", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("oauth_token=only-token", { status: 200 });
    await expect(getRequestToken("ck", "cs", "http://cb", mockFetch)).rejects.toThrow(
      "Invalid request token response",
    );
  });
});

describe("exchangeForAccessToken", () => {
  it("posts a signed body with the request token and verifier, and returns access tokens", async () => {
    let capturedInit: RequestInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return new Response("oauth_token=access-token&oauth_token_secret=access-secret", {
        status: 200,
      });
    };

    const result = await exchangeForAccessToken(
      "ck",
      "cs",
      "req-tok",
      "req-sec",
      "verifier",
      mockFetch,
    );

    expect(result.token).toBe("access-token");
    expect(result.tokenSecret).toBe("access-secret");

    const body = Object.fromEntries(new URLSearchParams(String(capturedInit?.body)));
    expect(body.oauth_token).toBe("req-tok");
    expect(body.oauth_verifier).toBe("verifier");
    expect(body.oauth_signature).toBeTruthy();
  });

  it("throws on a non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => new Response("bad", { status: 403 });
    await expect(
      exchangeForAccessToken("ck", "cs", "req-tok", "req-sec", "v", mockFetch),
    ).rejects.toThrow("FatSecret access token exchange failed (403)");
  });

  it("throws when the response lacks token fields", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("oauth_token=access-only", { status: 200 });
    await expect(
      exchangeForAccessToken("ck", "cs", "req-tok", "req-sec", "v", mockFetch),
    ).rejects.toThrow("Invalid access token response");
  });
});
