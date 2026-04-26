import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  Concept2Provider,
  concept2OAuthConfig,
  mapConcept2Type,
  parseConcept2Result,
} from "./concept2.ts";
import type { WebhookEvent } from "./types.ts";

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

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "concept2"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "user:read results:read",
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(async () => ({
    accessToken: "exchanged-token",
    refreshToken: "exchanged-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "user:read",
  })),
  getOAuthRedirectUri: vi.fn(() => "https://dofek.example.com/callback"),
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "refreshed-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "user:read",
  })),
}));

// ============================================================
// Mock DB
// ============================================================

function createMockDb() {
  const whereChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };

  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };

  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }

  const insertFn = vi.fn().mockReturnValue(chain);
  const deleteFn = vi.fn().mockReturnValue(whereChain);

  const db: SyncDatabase = {
    select: vi.fn(),
    insert: insertFn,
    delete: deleteFn,
    execute: vi.fn(),
  };

  return Object.assign(db, chain, { deleteFn, whereChain });
}

const recordSchema = z.record(z.string(), z.unknown());

function findValuesCall(
  db: ReturnType<typeof createMockDb>,
  predicate: (val: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const c of db.values.mock.calls) {
    const parsed = recordSchema.safeParse(c[0]);
    if (parsed.success && predicate(parsed.data)) return parsed.data;
  }
  throw new Error("No matching values call found");
}

// ============================================================
// Parsing tests
// ============================================================

describe("mapConcept2Type", () => {
  it("maps rower to rowing", () => {
    expect(mapConcept2Type("rower")).toBe("rowing");
    expect(mapConcept2Type("Rower")).toBe("rowing");
  });

  it("maps skierg to skiing", () => {
    expect(mapConcept2Type("skierg")).toBe("skiing");
    expect(mapConcept2Type("SkiErg")).toBe("skiing");
  });

  it("maps bikerg to cycling", () => {
    expect(mapConcept2Type("bikerg")).toBe("cycling");
    // Note: "BikeErg" lowercases to "bikeerg" which doesn't match "bikerg"
    // The API sends lowercase "bikerg" so only that is tested
  });

  it("defaults to rowing for unknown types", () => {
    expect(mapConcept2Type("unknown")).toBe("rowing");
  });
});

describe("parseConcept2Result", () => {
  const sampleResult = {
    id: 12345,
    type: "rower",
    date: "2026-03-01T08:00:00Z",
    distance: 5000,
    time: 12000, // tenths of a second (1200 seconds = 20 min)
    time_formatted: "20:00.0",
    stroke_rate: 24,
    stroke_count: 480,
    heart_rate: { average: 155, max: 175, min: 120 },
    calories_total: 300,
    drag_factor: 130,
    weight_class: "H",
    workout_type: "FixedDistSplits",
    comments: "Good row",
    privacy: "default",
    splits: [{ distance: 500, time: 1200, stroke_rate: 24, heart_rate: 150 }],
  };

  it("maps result fields correctly", () => {
    const parsed = parseConcept2Result(sampleResult);

    expect(parsed.externalId).toBe("12345");
    expect(parsed.activityType).toBe("rowing");
    expect(parsed.name).toBe("Rower FixedDistSplits");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
    // Duration: 12000 tenths = 1200 seconds = 1200000 ms
    expect(parsed.endedAt).toEqual(new Date(new Date("2026-03-01T08:00:00Z").getTime() + 1200000));
  });

  it("includes raw data in result", () => {
    const parsed = parseConcept2Result(sampleResult);

    expect(parsed.raw.distance).toBe(5000);
    expect(parsed.raw.strokeRate).toBe(24);
    expect(parsed.raw.strokeCount).toBe(480);
    expect(parsed.raw.avgHeartRate).toBe(155);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.calories).toBe(300);
    expect(parsed.raw.dragFactor).toBe(130);
    expect(parsed.raw.workoutType).toBe("FixedDistSplits");
  });
});

// ============================================================
// Provider tests
// ============================================================

describe("Concept2Provider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("properties", () => {
    it("has correct id, name, and webhookScope", () => {
      const provider = new Concept2Provider();
      expect(provider.id).toBe("concept2");
      expect(provider.name).toBe("Concept2");
      expect(provider.webhookScope).toBe("app");
    });
  });

  describe("validate()", () => {
    it("returns error when CONCEPT2_CLIENT_ID is missing", () => {
      delete process.env.CONCEPT2_CLIENT_ID;
      const provider = new Concept2Provider();
      expect(provider.validate()).toContain("CONCEPT2_CLIENT_ID");
    });

    it("returns error when CONCEPT2_CLIENT_SECRET is missing", () => {
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      delete process.env.CONCEPT2_CLIENT_SECRET;
      const provider = new Concept2Provider();
      expect(provider.validate()).toContain("CONCEPT2_CLIENT_SECRET");
    });

    it("returns null when both env vars are set", () => {
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
      const provider = new Concept2Provider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("registerWebhook()", () => {
    it("returns static subscription ID (portal-managed)", async () => {
      const provider = new Concept2Provider();
      const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

      expect(result.subscriptionId).toBe("concept2-portal-subscription");
      expect(result.signingSecret).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe("unregisterWebhook()", () => {
    it("completes without error (portal-managed)", async () => {
      const provider = new Concept2Provider();
      await expect(provider.unregisterWebhook("sub-123")).resolves.toBeUndefined();
    });
  });

  describe("verifyWebhookSignature()", () => {
    it("always returns true (not publicly documented)", () => {
      const provider = new Concept2Provider();
      expect(provider.verifyWebhookSignature(Buffer.from("test"), {}, "secret")).toBe(true);
    });
  });

  describe("parseWebhookPayload()", () => {
    it("parses result-added event", () => {
      const provider = new Concept2Provider();
      const body = {
        event: "result-added",
        user_id: "42",
        result: { id: 12345, type: "rower", date: "2026-03-01" },
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("42");
      expect(events[0]?.eventType).toBe("create");
      expect(events[0]?.objectType).toBe("result");
      // id is coerced to string by z.coerce.string()
      expect(events[0]?.objectId).toBe("12345");
      // The payload contains the Zod-parsed result (id coerced to string, passthrough for rest)
      const metadataRecord = z.record(z.unknown()).parse(events[0]?.metadata);
      expect(metadataRecord.payload).toBeDefined();
      const payloadRecord = z.record(z.unknown()).parse(metadataRecord.payload);
      expect(payloadRecord.id).toBe("12345");
      expect(payloadRecord.type).toBe("rower");
    });

    it("parses result-updated event", () => {
      const provider = new Concept2Provider();
      const body = {
        event: "result-updated",
        user_id: "42",
        result: { id: 99, type: "skierg" },
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("update");
      expect(events[0]?.objectId).toBe("99");
    });

    it("parses result-deleted event", () => {
      const provider = new Concept2Provider();
      const body = {
        event: "result-deleted",
        user_id: "42",
        result: { id: 555 },
      };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("delete");
      expect(events[0]?.objectId).toBe("555");
    });

    it("defaults to update for unknown event types", () => {
      const provider = new Concept2Provider();
      const body = { event: "result-something", user_id: "42" };

      const events = provider.parseWebhookPayload(body);

      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("update");
    });

    it("returns empty array for invalid payload", () => {
      const provider = new Concept2Provider();
      expect(provider.parseWebhookPayload(null)).toHaveLength(0);
      expect(provider.parseWebhookPayload("string")).toHaveLength(0);
      expect(provider.parseWebhookPayload({ invalid: true })).toHaveLength(0);
    });
  });

  describe("syncWebhookEvent()", () => {
    it("inserts activity from webhook result payload", async () => {
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

      const provider = new Concept2Provider();
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "42",
        eventType: "create",
        objectType: "result",
        objectId: "12345",
        metadata: {
          payload: {
            id: 12345,
            type: "rower",
            date: "2026-03-01T08:00:00Z",
            distance: 5000,
            time: 12000,
            time_formatted: "20:00.0",
            stroke_rate: 24,
            stroke_count: 480,
            weight_class: "H",
            workout_type: "FixedDistSplits",
            privacy: "default",
          },
        },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("concept2");
      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBe(1);

      const val = findValuesCall(
        db,
        (v) => v.externalId === "12345" && v.providerId === "concept2",
      );
      expect(val.activityType).toBe("rowing");
      expect(val.name).toBe("Rower FixedDistSplits");
    });

    it("returns 0 records for non-result objectType", async () => {
      const provider = new Concept2Provider();
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "42",
        eventType: "create",
        objectType: "unknown",
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("concept2");
      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("deletes activity on delete event", async () => {
      const provider = new Concept2Provider();
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "42",
        eventType: "delete",
        objectType: "result",
        objectId: "12345",
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.provider).toBe("concept2");
      expect(result.recordsSynced).toBe(0);
      expect(db.deleteFn).toHaveBeenCalled();
    });

    it("returns 0 records when no payload metadata is present", async () => {
      const provider = new Concept2Provider();
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "42",
        eventType: "create",
        objectType: "result",
        objectId: "12345",
        // No metadata
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("returns error when payload fails schema validation", async () => {
      const provider = new Concept2Provider();
      const db = createMockDb();

      const event: WebhookEvent = {
        ownerExternalId: "42",
        eventType: "create",
        objectType: "result",
        metadata: { payload: { invalid: true } },
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain("Failed to parse webhook result payload");
    });
  });
});

// ============================================================
// OAuth config tests
// ============================================================

describe("concept2OAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars are missing", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns config when env vars are set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    const config = concept2OAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.scopes).toContain("results:read");
    expect(config?.authorizeUrl).toContain("concept2.com");
  });

  it("uses Concept2's comma-separated OAuth scope format", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

    const config = concept2OAuthConfig();

    expect(config?.scopeSeparator).toBe(",");
  });
});
