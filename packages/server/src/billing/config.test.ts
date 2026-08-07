import { afterEach, describe, expect, it } from "vitest";
import { getStripeBillingConfig } from "./config.ts";

const originalEnv = { ...process.env };

function setBillingEnv(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";
  process.env.STRIPE_PRICE_ID = "price_123";
  process.env.PUBLIC_URL = "https://app.example.com";
  Object.assign(process.env, overrides);
}

describe("getStripeBillingConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the Stripe billing environment config", () => {
    setBillingEnv();

    expect(getStripeBillingConfig()).toEqual({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_123",
      priceId: "price_123",
      appBaseUrl: "https://app.example.com",
    });
  });

  it("normalizes the public app URL for return URL composition", () => {
    setBillingEnv({ PUBLIC_URL: " https://app.example.com/ " });

    expect(getStripeBillingConfig().appBaseUrl).toBe("https://app.example.com");
  });

  it("fails fast when the public app URL is blank after trimming", () => {
    setBillingEnv({ PUBLIC_URL: "   " });

    expect(() => getStripeBillingConfig()).toThrow("PUBLIC_URL environment variable is required");
  });

  it("fails fast when the public app URL is invalid", () => {
    setBillingEnv({ PUBLIC_URL: "not a url" });

    expect(() => getStripeBillingConfig()).toThrow(
      "PUBLIC_URL environment variable must be a valid URL",
    );
  });

  it("fails fast when the public app URL does not use HTTP", () => {
    setBillingEnv({ PUBLIC_URL: "file:///tmp/dofek" });

    expect(() => getStripeBillingConfig()).toThrow(
      "PUBLIC_URL environment variable must use http or https",
    );
  });

  it("fails fast when a required key is missing", () => {
    setBillingEnv({ STRIPE_PRICE_ID: "" });

    expect(() => getStripeBillingConfig()).toThrow(
      "STRIPE_PRICE_ID environment variable is required",
    );
  });
});
