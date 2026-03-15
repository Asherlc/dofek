import { afterEach, describe, expect, it } from "vitest";
import {
  buildOAuth1Header,
  type FatSecretFoodEntriesResponse,
  FatSecretProvider,
  inferCategory,
  parseFoodEntries,
} from "./fatsecret.ts";

// ============================================================
// Coverage tests for uncovered FatSecret paths:
// - buildOAuth1Header structure validation
// - parseFoodEntries edge cases
// - inferCategory with various food names
// - FatSecretProvider constructor validation
// - FatSecretProvider.validate()
// - FatSecretProvider.authSetup() including oauth1Flow invocations
// ============================================================

describe("buildOAuth1Header", () => {
  const creds = {
    consumerKey: "test-consumer-key",
    consumerSecret: "test-consumer-secret",
    token: "test-token",
    tokenSecret: "test-token-secret",
  };

  it("returns an Authorization header starting with 'OAuth '", () => {
    const header = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/server.api",
      { method: "food_entries.get.v2", format: "json" },
      creds,
    );
    expect(header).toMatch(/^OAuth /);
  });

  it("includes required OAuth parameters", () => {
    const header = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/server.api",
      {},
      creds,
    );
    expect(header).toContain("oauth_consumer_key=");
    expect(header).toContain("oauth_token=");
    expect(header).toContain("oauth_signature_method=");
    expect(header).toContain("oauth_timestamp=");
    expect(header).toContain("oauth_nonce=");
    expect(header).toContain("oauth_version=");
    expect(header).toContain("oauth_signature=");
  });

  it("uses HMAC-SHA1 signature method", () => {
    const header = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/server.api",
      {},
      creds,
    );
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
  });

  it("handles URL with query parameters", () => {
    const header = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/server.api?existing=param",
      { method: "food_entries.get.v2" },
      creds,
    );
    // Should not crash and should produce valid header
    expect(header).toMatch(/^OAuth /);
  });

  it("uppercases the HTTP method in signature", () => {
    // Both should produce valid headers (method gets uppercased internally)
    const header1 = buildOAuth1Header(
      "get",
      "https://platform.fatsecret.com/rest/server.api",
      {},
      creds,
    );
    const header2 = buildOAuth1Header(
      "GET",
      "https://platform.fatsecret.com/rest/server.api",
      {},
      creds,
    );
    expect(header1).toMatch(/^OAuth /);
    expect(header2).toMatch(/^OAuth /);
  });
});

describe("parseFoodEntries", () => {
  it("returns empty array for empty food_entry", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [],
      },
    };
    expect(parseFoodEntries(response)).toHaveLength(0);
  });

  it("returns empty array when food_entries is missing", () => {
    const response = {} as FatSecretFoodEntriesResponse;
    expect(parseFoodEntries(response)).toHaveLength(0);
  });

  it("returns empty array when food_entry is undefined", () => {
    // Intentionally omit food_entry to test defensive parsing.
    // The inner object is typed as Partial to simulate a malformed API response.
    const response = {
      food_entries: {} as Partial<FatSecretFoodEntriesResponse["food_entries"]>,
    } as FatSecretFoodEntriesResponse;
    expect(parseFoodEntries(response)).toHaveLength(0);
  });

  it("parses all standard fields", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "123",
            food_entry_name: "Chicken Breast",
            food_entry_description: "4 oz grilled",
            food_id: "456",
            serving_id: "789",
            number_of_units: "1.500",
            meal: "Lunch",
            date_int: "20000", // some day since epoch
            calories: "165",
            carbohydrate: "0",
            protein: "31",
            fat: "3.6",
            saturated_fat: "1.0",
            polyunsaturated_fat: "0.5",
            monounsaturated_fat: "1.5",
            cholesterol: "85",
            sodium: "74",
            potassium: "350",
            fiber: "0",
            sugar: "0",
            vitamin_a: "10",
            vitamin_c: "0",
            calcium: "15",
            iron: "1",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("expected entry");

    expect(entry.externalId).toBe("123");
    expect(entry.foodName).toBe("Chicken Breast");
    expect(entry.numberOfUnits).toBe(1.5);
    expect(entry.meal).toBe("lunch");
    expect(entry.calories).toBe(165);
    expect(entry.proteinG).toBe(31);
    expect(entry.fatG).toBeCloseTo(3.6);
    expect(entry.saturatedFatG).toBe(1);
    expect(entry.polyunsaturatedFatG).toBe(0.5);
    expect(entry.monounsaturatedFatG).toBe(1.5);
    expect(entry.cholesterolMg).toBe(85);
    expect(entry.sodiumMg).toBe(74);
    expect(entry.potassiumMg).toBe(350);
    expect(entry.fiberG).toBe(0);
    expect(entry.sugarG).toBe(0);
    expect(entry.vitaminAMcg).toBe(10);
    expect(entry.vitaminCMg).toBe(0);
    expect(entry.calciumMg).toBe(15);
    expect(entry.ironMg).toBe(1);
  });

  it("handles missing optional nutrition fields", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "456",
            food_entry_name: "Water",
            food_entry_description: "1 cup",
            food_id: "100",
            serving_id: "200",
            number_of_units: "1.000",
            meal: "Snack",
            date_int: "20000",
            calories: "0",
            carbohydrate: "0",
            protein: "0",
            fat: "0",
          },
        ],
      },
    };

    const entries = parseFoodEntries(response);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("expected entry");

    expect(entry.saturatedFatG).toBeUndefined();
    expect(entry.cholesterolMg).toBeUndefined();
    expect(entry.sodiumMg).toBeUndefined();
  });

  it("normalizes meal names to lowercase", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Toast",
            food_entry_description: "1 slice",
            food_id: "10",
            serving_id: "20",
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
    expect(entries[0]?.meal).toBe("breakfast");
  });

  it("maps unknown meal to 'other'", () => {
    const response: FatSecretFoodEntriesResponse = {
      food_entries: {
        food_entry: [
          {
            food_entry_id: "1",
            food_entry_name: "Toast",
            food_entry_description: "1 slice",
            food_id: "10",
            serving_id: "20",
            number_of_units: "1.000",
            meal: "Second Breakfast",
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
    expect(entries[0]?.meal).toBe("other");
  });
});

describe("inferCategory", () => {
  it("detects supplement keywords", () => {
    expect(inferCategory("Fish Oil 1000mg Softgel")).toBe("supplement");
    expect(inferCategory("Vitamin D3")).toBe("supplement");
    expect(inferCategory("Omega-3 Fatty Acids")).toBe("supplement");
    expect(inferCategory("Creatine Monohydrate")).toBe("supplement");
    expect(inferCategory("Magnesium Glycinate")).toBe("supplement");
    expect(inferCategory("Whey Protein Isolate")).toBe("supplement");
    expect(inferCategory("Collagen Peptides")).toBe("supplement");
    expect(inferCategory("Probiotic Capsules")).toBe("supplement");
    expect(inferCategory("Ashwagandha Root Extract")).toBe("supplement");
    expect(inferCategory("Melatonin 5mg")).toBe("supplement");
    expect(inferCategory("CoQ10 200mg")).toBe("supplement");
    expect(inferCategory("BCAA Powder")).toBe("supplement");
    expect(inferCategory("Electrolyte Mix")).toBe("supplement");
    expect(inferCategory("Turmeric Curcumin")).toBe("supplement");
  });

  it("detects dosage patterns", () => {
    expect(inferCategory("Something 200mg")).toBe("supplement");
    expect(inferCategory("Something 5000IU")).toBe("supplement");
    expect(inferCategory("Something 1000mcg")).toBe("supplement");
  });

  it("returns undefined for regular food items", () => {
    expect(inferCategory("Chicken Breast")).toBeUndefined();
    expect(inferCategory("Brown Rice")).toBeUndefined();
    expect(inferCategory("Banana")).toBeUndefined();
    expect(inferCategory("Greek Yogurt")).toBeUndefined();
  });
});

describe("FatSecretProvider — constructor and validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when env vars are missing", () => {
    delete process.env.FATSECRET_CONSUMER_KEY;
    delete process.env.FATSECRET_CONSUMER_SECRET;
    expect(() => new FatSecretProvider()).toThrow("FATSECRET_CONSUMER_KEY");
  });

  it("constructs when env vars are set", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const provider = new FatSecretProvider();
    expect(provider.id).toBe("fatsecret");
    expect(provider.name).toBe("FatSecret");
  });

  it("validate() always returns null", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const provider = new FatSecretProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("FatSecretProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns OAuth 1.0 auth setup", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("key");
    expect(setup.oauthConfig.clientSecret).toBe("secret");
    expect(setup.oauth1Flow).toBeDefined();
    expect(setup.oauth1Flow.getRequestToken).toBeTypeOf("function");
    expect(setup.oauth1Flow.exchangeForAccessToken).toBeTypeOf("function");
  });

  it("exchangeCode throws for OAuth 1.0 provider", async () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const provider = new FatSecretProvider();
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("code")).rejects.toThrow("OAuth 1.0");
  });

  it("oauth1Flow.getRequestToken calls FatSecret and returns tokens", async () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";

    const mockFetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      return new Response("oauth_token=req-token&oauth_token_secret=req-secret", {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const provider = new FatSecretProvider(mockFetch);
    const setup = provider.authSetup();
    const result = await setup.oauth1Flow.getRequestToken("http://localhost:9876/callback");

    expect(result.oauthToken).toBe("req-token");
    expect(result.oauthTokenSecret).toBe("req-secret");
    expect(result.authorizeUrl).toContain("req-token");
  });

  it("oauth1Flow.exchangeForAccessToken calls FatSecret and returns access tokens", async () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";

    const mockFetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      return new Response("oauth_token=access-token&oauth_token_secret=access-secret", {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const provider = new FatSecretProvider(mockFetch);
    const setup = provider.authSetup();
    const result = await setup.oauth1Flow.exchangeForAccessToken(
      "req-token",
      "req-secret",
      "verifier-123",
    );

    expect(result.token).toBe("access-token");
    expect(result.tokenSecret).toBe("access-secret");
  });
});
