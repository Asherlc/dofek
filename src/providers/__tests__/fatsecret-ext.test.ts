import { afterEach, describe, expect, it } from "vitest";
import {
  buildOAuth1Header,
  type FatSecretFoodEntriesResponse,
  FatSecretProvider,
  inferCategory,
  type OAuth1Credentials,
  parseFoodEntries,
} from "../fatsecret.ts";

// ============================================================
// Extended coverage tests for FatSecret provider
// Focus on: OAuth 1.0 header edge cases, parsing edge cases,
// inferCategory completeness, authSetup oauth1Flow
// ============================================================

describe("buildOAuth1Header — signature correctness", () => {
  const creds: OAuth1Credentials = {
    consumerKey: "my-key",
    consumerSecret: "my-secret",
    token: "access-token",
    tokenSecret: "token-secret",
  };

  it("produces different signatures for different URLs", () => {
    const header1 = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/server.api",
      { method: "food_entries.get.v2" },
      creds,
    );
    const header2 = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/other.api",
      { method: "food_entries.get.v2" },
      creds,
    );
    // Extract signatures
    const sig1 = header1.match(/oauth_signature="([^"]+)"/)?.[1];
    const sig2 = header2.match(/oauth_signature="([^"]+)"/)?.[1];
    // Signatures should differ due to different URLs
    expect(sig1).toBeDefined();
    expect(sig2).toBeDefined();
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different methods", () => {
    const header1 = buildOAuth1Header("GET", "https://example.com/api", {}, creds);
    const header2 = buildOAuth1Header("POST", "https://example.com/api", {}, creds);
    const sig1 = header1.match(/oauth_signature="([^"]+)"/)?.[1];
    const sig2 = header2.match(/oauth_signature="([^"]+)"/)?.[1];
    expect(sig1).toBeDefined();
    expect(sig2).toBeDefined();
    expect(sig1).not.toBe(sig2);
  });

  it("includes consumer key in header", () => {
    const header = buildOAuth1Header("GET", "https://example.com/api", {}, creds);
    expect(header).toContain(`oauth_consumer_key="${creds.consumerKey}"`);
  });

  it("includes access token in header", () => {
    const header = buildOAuth1Header("GET", "https://example.com/api", {}, creds);
    expect(header).toContain(`oauth_token="${creds.token}"`);
  });

  it("includes version 1.0", () => {
    const header = buildOAuth1Header("GET", "https://example.com/api", {}, creds);
    expect(header).toContain('oauth_version="1.0"');
  });

  it("handles special characters in parameters", () => {
    const header = buildOAuth1Header(
      "GET",
      "https://example.com/api",
      { "special param": "value with spaces & symbols!" },
      creds,
    );
    expect(header).toMatch(/^OAuth /);
  });
});

describe("parseFoodEntries — extended edge cases", () => {
  it("handles multiple entries on same day", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Eggs",
            food_entry_description: "2 large",
            food_id: "10",
            serving_id: "20",
            number_of_units: "2.000",
            meal: "Breakfast",
            date_int: "20000",
            calories: "140",
            carbohydrate: "1",
            protein: "12",
            fat: "10",
          },
          {
            food_entry_id: "2",
            food_entry_name: "Toast",
            food_entry_description: "1 slice",
            food_id: "11",
            serving_id: "21",
            number_of_units: "1.000",
            meal: "Breakfast",
            date_int: "20000",
            calories: "80",
            carbohydrate: "14",
            protein: "3",
            fat: "1",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.date).toBe(entries[1]?.date);
  });

  it("converts date_int correctly for known date", () => {
    // Day 0 = 1970-01-01, day 19783 = 2024-02-29 (leap year)
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Test",
            food_entry_description: "test",
            food_id: "1",
            serving_id: "1",
            number_of_units: "1.000",
            meal: "Lunch",
            date_int: "0",
            calories: "0",
            carbohydrate: "0",
            protein: "0",
            fat: "0",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries[0]?.date).toBe("1970-01-01");
  });

  it("parses fractional number_of_units", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Rice",
            food_entry_description: "0.75 cup",
            food_id: "1",
            serving_id: "1",
            number_of_units: "0.750",
            meal: "Dinner",
            date_int: "20000",
            calories: "162",
            carbohydrate: "34",
            protein: "3.4",
            fat: "0.4",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries[0]?.numberOfUnits).toBeCloseTo(0.75);
  });

  it("maps Dinner meal correctly", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Salmon",
            food_entry_description: "6oz fillet",
            food_id: "1",
            serving_id: "1",
            number_of_units: "1.000",
            meal: "Dinner",
            date_int: "20000",
            calories: "350",
            carbohydrate: "0",
            protein: "40",
            fat: "20",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries[0]?.meal).toBe("dinner");
  });
});

describe("inferCategory — extended keyword coverage", () => {
  it("detects multivitamin", () => {
    expect(inferCategory("Men's Multivitamin")).toBe("supplement");
  });

  it("detects tablets", () => {
    expect(inferCategory("Iron Tablets")).toBe("supplement");
  });

  it("detects capsules", () => {
    expect(inferCategory("Vitamin E Capsules")).toBe("supplement");
  });

  it("detects zinc", () => {
    expect(inferCategory("Zinc Picolinate")).toBe("supplement");
  });

  it("detects prebiotic", () => {
    expect(inferCategory("Prebiotic Fiber Supplement")).toBe("supplement");
  });

  it("detects glutamine", () => {
    expect(inferCategory("L-Glutamine Powder")).toBe("supplement");
  });

  it("detects casein protein", () => {
    expect(inferCategory("Casein Protein Shake")).toBe("supplement");
  });

  it("detects protein powder", () => {
    expect(inferCategory("Chocolate Protein Powder")).toBe("supplement");
  });

  it("detects iron supplement", () => {
    expect(inferCategory("Iron Supplement 65mg")).toBe("supplement");
  });

  it("detects calcium supplement", () => {
    expect(inferCategory("Calcium Supplement Chewable")).toBe("supplement");
  });

  it("detects curcumin", () => {
    expect(inferCategory("Curcumin Complex")).toBe("supplement");
  });

  it("detects extract", () => {
    expect(inferCategory("Green Tea Extract")).toBe("supplement");
  });

  it("detects omega 3 (space)", () => {
    expect(inferCategory("Omega 3 Fish Oil")).toBe("supplement");
  });

  it("detects dosage with space before unit", () => {
    expect(inferCategory("Something 500 mg")).toBe("supplement");
  });

  it("detects dosage with mcg unit", () => {
    expect(inferCategory("Folic acid 800mcg")).toBe("supplement");
  });

  it("does not flag regular food with numbers", () => {
    // numbers without dosage units should not trigger
    expect(inferCategory("2% Milk")).toBeUndefined();
    expect(inferCategory("100 Calorie Snack Pack")).toBeUndefined();
  });
});

describe("FatSecretProvider — authSetup oauth1Flow", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("oauth1Flow.getRequestToken is callable", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";

    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauth1Flow.getRequestToken).toBeTypeOf("function");
  });

  it("oauth1Flow.exchangeForAccessToken is callable", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";

    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauth1Flow.exchangeForAccessToken).toBeTypeOf("function");
  });

  it("oauthConfig has correct authorizeUrl", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";

    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.authorizeUrl).toContain("fatsecret.com");
    expect(setup.oauthConfig.tokenUrl).toContain("fatsecret.com");
  });

  it("oauthConfig redirectUri uses env var or default", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.redirectUri).toContain("localhost");
  });

  it("oauthConfig uses OAUTH_REDIRECT_URI when set", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://my-app.com/callback";

    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.redirectUri).toBe("https://my-app.com/callback");
  });

  it("oauthConfig scopes is empty array for OAuth 1.0", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";

    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.scopes).toEqual([]);
  });
});

describe("FatSecretProvider — custom fetch", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts custom fetchFn", () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-secret";

    const customFetch = (() => {}) as unknown as typeof globalThis.fetch;
    const provider = new FatSecretProvider(customFetch);
    expect(provider.id).toBe("fatsecret");
  });
});
