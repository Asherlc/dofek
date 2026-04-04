import { afterEach, describe, expect, it } from "vitest";
import { getOAuthRedirectUri } from "./oauth.ts";

describe("getOAuthRedirectUri", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OAUTH_REDIRECT_URI;
    delete process.env.OAUTH_REDIRECT_URI;
  });

  it("uses OAUTH_REDIRECT_URI when set", () => {
    process.env.OAUTH_REDIRECT_URI = "https://custom.com/callback";
    expect(getOAuthRedirectUri()).toBe("https://custom.com/callback");
  });

  it("builds dynamic http URI for localhost", () => {
    delete process.env.OAUTH_REDIRECT_URI;
    delete process.env.OAUTH_REDIRECT_URI;
    expect(getOAuthRedirectUri("localhost:3000")).toBe("http://localhost:3000/callback");
  });

  it("builds dynamic http URI for 127.0.0.1", () => {
    expect(getOAuthRedirectUri("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/callback");
  });

  it("builds dynamic http URI for private network IP (192.168.x.x)", () => {
    expect(getOAuthRedirectUri("192.168.1.50:3000")).toBe("http://192.168.1.50:3000/callback");
  });

  it("builds dynamic http URI for private network IP (10.x.x.x)", () => {
    expect(getOAuthRedirectUri("10.0.0.1:3000")).toBe("http://10.0.0.1:3000/callback");
  });

  it("builds dynamic http URI for private network IP (172.x.x.x)", () => {
    expect(getOAuthRedirectUri("172.16.0.1:3000")).toBe("http://172.16.0.1:3000/callback");
  });

  it("builds dynamic https URI for public domains", () => {
    expect(getOAuthRedirectUri("dofek.example.com")).toBe("https://dofek.example.com/callback");
  });

  it("falls back to default production URI when no host and no env vars", () => {
    delete process.env.OAUTH_REDIRECT_URI;
    delete process.env.OAUTH_REDIRECT_URI;
    expect(getOAuthRedirectUri()).toBe("https://dofek.asherlc.com/callback");
  });
});
