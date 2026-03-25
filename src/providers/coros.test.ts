import { afterEach, describe, expect, it, vi } from "vitest";
import { CorosProvider, corosOAuthConfig, mapCorosSportType, parseCorosWorkout } from "./coros.ts";

// ============================================================
// Mock external dependencies
// ============================================================

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{ recordCount: number; result: unknown }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "coros"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "",
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(async () => ({
    accessToken: "exchanged-token",
    refreshToken: "exchanged-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "",
  })),
  getOAuthRedirectUri: vi.fn(() => "https://dofek.example.com/callback"),
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "refreshed-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "",
  })),
}));

// ============================================================
// Parsing tests
// ============================================================

describe("mapCorosSportType", () => {
  it("maps known sport modes", () => {
    expect(mapCorosSportType(8)).toBe("running");
    expect(mapCorosSportType(9)).toBe("cycling");
    expect(mapCorosSportType(10)).toBe("swimming");
    expect(mapCorosSportType(13)).toBe("strength");
    expect(mapCorosSportType(14)).toBe("walking");
    expect(mapCorosSportType(15)).toBe("hiking");
    expect(mapCorosSportType(17)).toBe("rowing");
    expect(mapCorosSportType(18)).toBe("yoga");
    expect(mapCorosSportType(22)).toBe("trail_running");
    expect(mapCorosSportType(23)).toBe("skiing");
    expect(mapCorosSportType(27)).toBe("triathlon");
    expect(mapCorosSportType(100)).toBe("other");
  });

  it("returns other for unknown sport modes", () => {
    expect(mapCorosSportType(999)).toBe("other");
    expect(mapCorosSportType(0)).toBe("other");
  });
});

describe("parseCorosWorkout", () => {
  const sampleWorkout = {
    labelId: "wk-001",
    mode: 8,
    subMode: 0,
    startTime: 1740830400, // 2025-03-01 12:00:00 UTC
    endTime: 1740834000, // 2025-03-01 13:00:00 UTC
    duration: 3600,
    distance: 10000,
    avgHeartRate: 155,
    maxHeartRate: 180,
    avgSpeed: 278,
    maxSpeed: 350,
    totalCalories: 600,
    avgCadence: 170,
    avgPower: 250,
    maxPower: 400,
    totalAscent: 100,
    totalDescent: 95,
  };

  it("maps workout fields correctly", () => {
    const parsed = parseCorosWorkout(sampleWorkout);

    expect(parsed.externalId).toBe("wk-001");
    expect(parsed.activityType).toBe("running");
    expect(parsed.name).toBe("COROS running");
    expect(parsed.startedAt).toEqual(new Date(1740830400 * 1000));
    expect(parsed.endedAt).toEqual(new Date(1740834000 * 1000));
  });

  it("includes raw data", () => {
    const parsed = parseCorosWorkout(sampleWorkout);

    expect(parsed.raw.distance).toBe(10000);
    expect(parsed.raw.avgHeartRate).toBe(155);
    expect(parsed.raw.maxHeartRate).toBe(180);
    expect(parsed.raw.calories).toBe(600);
    expect(parsed.raw.avgPower).toBe(250);
    expect(parsed.raw.totalAscent).toBe(100);
    expect(parsed.raw.mode).toBe(8);
  });
});

// ============================================================
// Provider tests
// ============================================================

describe("CorosProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("properties", () => {
    it("has correct id, name, and webhookScope", () => {
      const provider = new CorosProvider();
      expect(provider.id).toBe("coros");
      expect(provider.name).toBe("COROS");
      expect(provider.webhookScope).toBe("app");
    });
  });

  describe("validate()", () => {
    it("returns error when COROS_CLIENT_ID is missing", () => {
      delete process.env.COROS_CLIENT_ID;
      const provider = new CorosProvider();
      expect(provider.validate()).toContain("COROS_CLIENT_ID");
    });

    it("returns error when COROS_CLIENT_SECRET is missing", () => {
      process.env.COROS_CLIENT_ID = "test-id";
      delete process.env.COROS_CLIENT_SECRET;
      const provider = new CorosProvider();
      expect(provider.validate()).toContain("COROS_CLIENT_SECRET");
    });

    it("returns null when both env vars are set", () => {
      process.env.COROS_CLIENT_ID = "test-id";
      process.env.COROS_CLIENT_SECRET = "test-secret";
      const provider = new CorosProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("registerWebhook()", () => {
    it("returns static subscription ID (partner-managed)", async () => {
      const provider = new CorosProvider();
      const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

      expect(result.subscriptionId).toBe("coros-partner-subscription");
      expect(result.signingSecret).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe("unregisterWebhook()", () => {
    it("completes without error (partner-managed)", async () => {
      const provider = new CorosProvider();
      await expect(provider.unregisterWebhook("sub-123")).resolves.toBeUndefined();
    });
  });

  describe("verifyWebhookSignature()", () => {
    it("always returns true (partner agreement)", () => {
      const provider = new CorosProvider();
      expect(provider.verifyWebhookSignature(Buffer.from("test"), {}, "secret")).toBe(true);
    });
  });

  describe("parseWebhookPayload()", () => {
    it("parses sportDataList payload", () => {
      const provider = new CorosProvider();
      const body = {
        sportDataList: [
          { openId: "user-1", labelId: "wk-001" },
          { openId: "user-2", labelId: "wk-002" },
        ],
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(2);
      expect(events[0]?.ownerExternalId).toBe("user-1");
      expect(events[0]?.eventType).toBe("create");
      expect(events[0]?.objectType).toBe("workout");
      expect(events[0]?.objectId).toBe("wk-001");

      expect(events[1]?.ownerExternalId).toBe("user-2");
      expect(events[1]?.objectId).toBe("wk-002");
    });

    it("parses single openId payload", () => {
      const provider = new CorosProvider();
      const body = { openId: "user-1" };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("user-1");
      expect(events[0]?.eventType).toBe("create");
      expect(events[0]?.objectType).toBe("workout");
    });

    it("handles sportDataList items without labelId", () => {
      const provider = new CorosProvider();
      const body = {
        sportDataList: [{ openId: "user-1" }],
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.objectId).toBeUndefined();
    });

    it("filters out invalid items from sportDataList", () => {
      const provider = new CorosProvider();
      const body = {
        sportDataList: [
          { openId: "user-1", labelId: "wk-001" },
          { invalid: true },
          "not-an-object",
        ],
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("user-1");
    });

    it("returns empty array for invalid payload", () => {
      const provider = new CorosProvider();
      expect(provider.parseWebhookPayload(null)).toHaveLength(0);
      expect(provider.parseWebhookPayload("string")).toHaveLength(0);
      expect(provider.parseWebhookPayload({ invalid: true })).toHaveLength(0);
    });
  });
});

// ============================================================
// OAuth config tests
// ============================================================

describe("corosOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars are missing", () => {
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;
    expect(corosOAuthConfig()).toBeNull();
  });

  it("returns config when env vars are set", () => {
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    const config = corosOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.authorizeUrl).toContain("coros.com");
    expect(config?.tokenUrl).toContain("coros.com");
  });
});
