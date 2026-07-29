import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Mock external dependencies
// ============================================================

vi.mock("../db/sync-log.ts", () => ({
  PartialSyncError: class PartialSyncError extends Error {
    readonly recordCount: number;
    override readonly cause: unknown;

    constructor(message: string, recordCount: number, cause: unknown) {
      super(message);
      this.name = "PartialSyncError";
      this.recordCount = recordCount;
      this.cause = cause;
    }
  },
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
  getOAuthRedirectUri: vi.fn(
    () => process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback",
  ),
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "refreshed-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "user:read",
  })),
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  markProviderActivityAbsent: vi.fn().mockResolvedValue(undefined),
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    markProviderActivityAbsent: providerActivityAbsenceMocks.markProviderActivityAbsent,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { ZodError, z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  Concept2Client,
  Concept2Provider,
  concept2OAuthConfig,
  mapConcept2Type,
  parseConcept2Result,
} from "./concept2.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import type { WebhookEvent } from "./types.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findUpsertValues(
  predicate: (values: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const call of providerActivityAbsenceMocks.upsertProviderActivity.mock.calls) {
    const values = call[1];
    if (isRecord(values) && predicate(values)) {
      return values;
    }
  }
  return undefined;
}

function findUpsertUpdate(
  predicate: (update: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const call of providerActivityAbsenceMocks.upsertProviderActivity.mock.calls) {
    const update = call[2];
    if (isRecord(update) && predicate(update)) {
      return update;
    }
  }
  return undefined;
}

// ============================================================
// Parsing tests
// ============================================================

describe("mapConcept2Type", () => {
  it("maps rower to rowing", () => {
    expect(mapConcept2Type("rower").canonicalType).toBe("rowing");
    expect(mapConcept2Type("Rower").canonicalType).toBe("rowing");
    expect(mapConcept2Type("ROWER").canonicalType).toBe("rowing");
  });

  it("maps skierg to skiing", () => {
    expect(mapConcept2Type("skierg").canonicalType).toBe("skiing");
    expect(mapConcept2Type("SkiErg").canonicalType).toBe("skiing");
  });

  it("maps bikerg to cycling", () => {
    expect(mapConcept2Type("bikerg").canonicalType).toBe("cycling");
    expect(mapConcept2Type("BikeErg").canonicalType).toBe("cycling");
  });

  it("defaults to rowing for unknown types", () => {
    expect(mapConcept2Type("unknown").canonicalType).toBe("rowing");
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
    expect(parsed.activityType.canonicalType).toBe("rowing");
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
    expect(parsed.raw.dragFactor).toBe(130);
    expect(parsed.raw.workoutType).toBe("FixedDistSplits");
  });

  it("parses a full result", () => {
    const result = {
      id: 12345,
      type: "rower",
      date: "2026-03-01 09:00:00",
      distance: 5000,
      time: 12000,
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
    expect(parsed.activityType.canonicalType).toBe("rowing");
    expect(parsed.name).toBe("Rower FixedDistanceFixedTime");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01 09:00:00"));
    expect(parsed.raw.distance).toBe(5000);
    expect(parsed.raw.strokeRate).toBe(26);
    expect(parsed.raw.strokeCount).toBe(520);
    expect(parsed.raw.avgHeartRate).toBe(155);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.dragFactor).toBe(125);
    expect(parsed.raw.workoutType).toBe("FixedDistanceFixedTime");
    expect(parsed.raw.weightClass).toBe("H");

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
    expect(parsed.activityType.canonicalType).toBe("skiing");
    expect(parsed.raw.avgHeartRate).toBeUndefined();
    expect(parsed.raw.maxHeartRate).toBeUndefined();
  });
});

// ============================================================
// Provider tests
// ============================================================

describe("Concept2Provider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    providerActivityAbsenceMocks.markProviderActivityAbsent.mockClear();
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
  });

  describe("properties", () => {
    it("has correct id, name, and webhookScope", () => {
      const provider = new Concept2Provider();
      expect(provider.id).toBe("concept2");
      expect(provider.name).toBe("Concept2");
      expect(provider.webhookScope).toBe("app");
    });
  });

  describe("authSetup()", () => {
    it("returns correct config", () => {
      process.env.CONCEPT2_CLIENT_ID = "id";
      process.env.CONCEPT2_CLIENT_SECRET = "secret";
      const setup = new Concept2Provider().authSetup();
      expect(setup.oauthConfig?.clientId).toBe("id");
      expect(setup.exchangeCode).toBeTypeOf("function");
      expect(setup.apiBaseUrl).toContain("concept2.com");
    });

    it("throws when env vars are missing", () => {
      delete process.env.CONCEPT2_CLIENT_ID;
      delete process.env.CONCEPT2_CLIENT_SECRET;
      expect(() => new Concept2Provider().authSetup()).toThrow("CONCEPT2_CLIENT_ID");
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
      const metadataRecord = z.record(z.string(), z.unknown()).parse(events[0]?.metadata);
      expect(metadataRecord.payload).toBeDefined();
      const payloadRecord = z.record(z.string(), z.unknown()).parse(metadataRecord.payload);
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

      const val = findUpsertValues(
        (values) => values.externalId === "12345" && values.providerId === "concept2",
      );
      expect(val?.activityType).toMatchObject({ canonicalType: "rowing" });
      expect(val?.name).toBe("Rower FixedDistSplits");

      const update = findUpsertUpdate(
        (rec) =>
          isRecord(rec.activityType) &&
          rec.activityType.canonicalType === "rowing",
      );
      expect(update).toEqual(
        expect.objectContaining({
          activityType: expect.objectContaining({
            canonicalType: "rowing",
            providerType: "rower",
          }),
          name: "Rower FixedDistSplits",
          startedAt: val?.startedAt,
          endedAt: val?.endedAt,
          raw: val?.raw,
        }),
      );
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

    it("marks activity provider-absent on delete event", async () => {
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
      expect(providerActivityAbsenceMocks.markProviderActivityAbsent).toHaveBeenCalledWith(db, {
        providerId: "concept2",
        externalId: "12345",
        userId: "00000000-0000-0000-0000-000000000001",
      });
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

  describe("sync()", () => {
    it("returns error when no tokens", async () => {
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

      const result = await new Concept2Provider().sync(
        new SyncRun({
          db: mockDb,
          window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        }),
      );
      expect(result.provider).toBe("concept2");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("skips results after the sync window end", async () => {
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

      const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
        Response.json({
          data: [
            {
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
            {
              id: 11111,
              type: "rower",
              date: "2026-03-01T23:59:59.999Z",
              distance: 5000,
              time: 12000,
              time_formatted: "20:00.0",
              stroke_rate: 24,
              stroke_count: 480,
              weight_class: "H",
              workout_type: "FixedDistSplits",
              privacy: "default",
            },
            {
              id: 67890,
              type: "rower",
              date: "2026-03-03T08:00:00Z",
              distance: 5000,
              time: 12000,
              time_formatted: "20:00.0",
              stroke_rate: 24,
              stroke_count: 480,
              weight_class: "H",
              workout_type: "FixedDistSplits",
              privacy: "default",
            },
          ],
          meta: {
            pagination: {
              total: 2,
              count: 2,
              per_page: 50,
              current_page: 1,
              total_pages: 1,
            },
          },
        });
      const provider = new Concept2Provider(mockFetch);
      const db = createMockDb();

      const result = await provider.sync(
        new SyncRun({
          db,
          window: SyncWindow.fromDateRange({
            sinceDate: "2026-03-01",
            untilDate: "2026-03-01",
          }),
        }),
      );

      expect(result.errors).toHaveLength(0);
      expect(result.recordsSynced).toBe(2);
      expect(findUpsertValues((value) => value.externalId === "12345")).toBeDefined();
      expect(findUpsertValues((value) => value.externalId === "11111")).toBeDefined();
      expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
        db,
        expect.objectContaining({ externalId: "67890" }),
        expect.any(Object),
      );
      expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          presentExternalIds: new Set(["12345", "11111"]),
        }),
      );
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

  it("returns null when CONCEPT2_CLIENT_SECRET is not set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns config when env vars are set", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    const config = concept2OAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("results:read");
    expect(config?.authorizeUrl).toContain("concept2.com");
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
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
  });

  it("uses Concept2's comma-separated OAuth scope format", () => {
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

    const config = concept2OAuthConfig();

    expect(config?.scopeSeparator).toBe(",");
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

// ============================================================
// Rate-limit aware fetch wiring
// ============================================================

describe("Concept2 — rate-limit aware fetch wiring", () => {
  const rateLimitedFetch: typeof globalThis.fetch = async (): Promise<Response> =>
    new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

  it("Concept2Client surfaces a 429 as a ProviderRateLimitError tagged 'concept2'", async () => {
    const client = new Concept2Client("access-token", rateLimitedFetch);

    const err = await client.getResults("2025-01-01").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("concept2");
      expect(err.statusCode).toBe(429);
    }
  });

  it("provider sync surfaces a 429 as a ProviderRateLimitError tagged 'concept2'", async () => {
    const provider = new Concept2Provider(rateLimitedFetch);
    const result = await provider.sync(
      new SyncRun({
        db: createMockDb(),
        window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    const cause = result.errors[0]?.cause;
    expect(cause).toBeInstanceOf(ProviderRateLimitError);
    if (cause instanceof ProviderRateLimitError) {
      expect(cause.providerId).toBe("concept2");
      expect(cause.statusCode).toBe(429);
    }
  });
});
