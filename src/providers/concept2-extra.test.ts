import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  Concept2Client,
  Concept2Provider,
  concept2OAuthConfig,
  mapConcept2Type,
  parseConcept2Result,
} from "./concept2.ts";

// ============================================================
// Tests targeting uncovered paths in concept2.ts
// ============================================================

describe("mapConcept2Type", () => {
  it("maps rower to rowing", () => {
    expect(mapConcept2Type("rower")).toBe("rowing");
    expect(mapConcept2Type("Rower")).toBe("rowing");
    expect(mapConcept2Type("ROWER")).toBe("rowing");
  });

  it("maps skierg to skiing", () => {
    expect(mapConcept2Type("skierg")).toBe("skiing");
    expect(mapConcept2Type("SkiErg")).toBe("skiing");
  });

  it("maps bikerg to cycling", () => {
    expect(mapConcept2Type("bikerg")).toBe("cycling");
    // Note: "BikeErg" lowercases to "bikeerg" (two e's), which doesn't match "bikerg"
    expect(mapConcept2Type("BikeErg")).toBe("rowing"); // falls to default
  });

  it("defaults to rowing for unknown types", () => {
    expect(mapConcept2Type("unknown")).toBe("rowing");
  });
});

describe("parseConcept2Result", () => {
  it("parses a full result", () => {
    const result = {
      id: 12345,
      type: "rower",
      date: "2026-03-01 09:00:00",
      distance: 5000,
      time: 12000, // tenths of second = 1200 seconds
      time_formatted: "20:00.0",
      stroke_rate: 26,
      stroke_count: 520,
      heart_rate: { average: 155, max: 175, min: 110 },
      calories_total: 300,
      drag_factor: 125,
      weight_class: "H",
      workout_type: "FixedDistanceFixedTime",
      privacy: "public",
    };

    const parsed = parseConcept2Result(result);
    expect(parsed.externalId).toBe("12345");
    expect(parsed.activityType).toBe("rowing");
    expect(parsed.name).toBe("Rower FixedDistanceFixedTime");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01 09:00:00"));
    expect(parsed.raw.distance).toBe(5000);
    expect(parsed.raw.strokeRate).toBe(26);
    expect(parsed.raw.strokeCount).toBe(520);
    expect(parsed.raw.avgHeartRate).toBe(155);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.calories).toBe(300);
    expect(parsed.raw.dragFactor).toBe(125);
    expect(parsed.raw.workoutType).toBe("FixedDistanceFixedTime");
    expect(parsed.raw.weightClass).toBe("H");

    // endedAt should be 1200 seconds after start
    const expectedEnd = new Date(parsed.startedAt.getTime() + 1200 * 1000);
    expect(parsed.endedAt).toEqual(expectedEnd);
  });

  it("handles result without heart rate", () => {
    const result = {
      id: 99,
      type: "skierg",
      date: "2026-03-01 10:00:00",
      distance: 2000,
      time: 6000,
      time_formatted: "10:00.0",
      stroke_rate: 30,
      stroke_count: 300,
      weight_class: "L",
      workout_type: "JustRow",
      privacy: "public",
    };

    const parsed = parseConcept2Result(result);
    expect(parsed.activityType).toBe("skiing");
    expect(parsed.raw.avgHeartRate).toBeUndefined();
    expect(parsed.raw.maxHeartRate).toBeUndefined();
  });
});

describe("concept2OAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when CONCEPT2_CLIENT_ID is not set", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns null when CONCEPT2_CLIENT_SECRET is not set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    const config = concept2OAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("results:read");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = concept2OAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = concept2OAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("Concept2Provider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns error when CONCEPT2_CLIENT_ID is missing", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(new Concept2Provider().validate()).toContain("CONCEPT2_CLIENT_ID");
  });

  it("validate returns error when CONCEPT2_CLIENT_SECRET is missing", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(new Concept2Provider().validate()).toContain("CONCEPT2_CLIENT_SECRET");
  });

  it("validate returns null when both are set", () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
    expect(new Concept2Provider().validate()).toBeNull();
  });

  it("authSetup returns correct config", () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
    const setup = new Concept2Provider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("concept2.com");
  });

  it("authSetup throws when env vars are missing", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(() => new Concept2Provider().authSetup()).toThrow("CONCEPT2_CLIENT_ID");
  });

  it("sync returns error when no tokens", async () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await new Concept2Provider().sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("concept2");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("Concept2Client", () => {
  it("adds Accept: application/json header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({
        data: [],
        meta: { pagination: { total: 0, count: 0, per_page: 50, current_page: 1, total_pages: 1 } },
      });
    };

    const client = new Concept2Client("test-token", mockFetch);
    await client.getResults("2026-03-01");

    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    expect(capturedHeaders.Accept).toBe("application/json");
  });

  it("fetches results with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({
        data: [],
        meta: { pagination: { total: 0, count: 0, per_page: 50, current_page: 1, total_pages: 1 } },
      });
    };

    const client = new Concept2Client("token", mockFetch);
    await client.getResults("2026-03-01", 2);

    expect(capturedUrl).toContain("/api/users/me/results");
    expect(capturedUrl).toContain("from=2026-03-01");
    expect(capturedUrl).toContain("page=2");
  });

  it("throws on non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new Concept2Client("bad-token", mockFetch);
    await expect(client.getResults("2026-03-01")).rejects.toThrow("API error 401");
  });

  it("rejects invalid response shapes via Zod", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ data: "not-an-array" });
    };

    const client = new Concept2Client("token", mockFetch);
    await expect(client.getResults("2026-03-01")).rejects.toThrow(ZodError);
  });

  it("validates and returns a correct results response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        data: [
          {
            id: 12345,
            type: "rower",
            date: "2026-03-01 09:00:00",
            distance: 5000,
            time: 12000,
            time_formatted: "20:00.0",
            stroke_rate: 26,
            stroke_count: 520,
            weight_class: "H",
            workout_type: "FixedDistanceFixedTime",
            privacy: "public",
          },
        ],
        meta: { pagination: { total: 1, count: 1, per_page: 50, current_page: 1, total_pages: 1 } },
      });
    };

    const client = new Concept2Client("token", mockFetch);
    const result = await client.getResults("2026-03-01");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(12345);
    expect(result.meta.pagination.total_pages).toBe(1);
  });
});
