import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

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
  ensureProvider: vi.fn(async () => "wger"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

vi.mock("../db/metric-stream-writer.ts", () => ({
  writeMetricStreamBatch: vi.fn().mockResolvedValue(1),
}));

import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { loadTokens } from "../db/tokens.ts";
import {
  parseWgerWeightEntry,
  parseWgerWorkoutSession,
  WgerProvider,
  wgerOAuthConfig,
} from "./wger.ts";

describe("parseWgerWorkoutSession", () => {
  it("parses a session with comment", () => {
    const session = {
      id: 42,
      date: "2026-03-01",
      comment: "Leg Day",
      impression: "2",
      time_start: "09:00",
      time_end: "10:30",
    };

    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.externalId).toBe("42");
    expect(parsed.activityType).toBe("strength");
    expect(parsed.name).toBe("Leg Day");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01"));
    expect(parsed.raw.comment).toBe("Leg Day");
    expect(parsed.raw.impression).toBe("2");
    expect(parsed.raw.timeStart).toBe("09:00");
    expect(parsed.raw.timeEnd).toBe("10:30");
  });

  it("uses 'Workout' name when comment is empty", () => {
    const session = {
      id: 1,
      date: "2026-03-01",
      comment: "",
      impression: "1",
      time_start: null,
      time_end: null,
    };

    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.name).toBe("Workout");
    expect(parsed.raw.timeStart).toBeNull();
    expect(parsed.raw.timeEnd).toBeNull();
  });
});

describe("parseWgerWeightEntry", () => {
  it("parses a weight entry", () => {
    const entry = {
      id: 100,
      date: "2026-03-01",
      weight: "85.5",
    };

    const parsed = parseWgerWeightEntry(entry);
    expect(parsed.externalId).toBe("100");
    expect(parsed.recordedAt).toEqual(new Date("2026-03-01"));
    expect(parsed.weightKg).toBe(85.5);
  });

  it("handles integer weight", () => {
    const parsed = parseWgerWeightEntry({ id: 1, date: "2026-03-01", weight: "80" });
    expect(parsed.weightKg).toBe(80);
  });
});

describe("wgerOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars missing", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(wgerOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    const config = wgerOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("wger.de");
    expect(config?.scopes).toContain("read");
  });
});

describe("WgerProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate checks env vars", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(new WgerProvider().validate()).toContain("WGER_CLIENT_ID");
    process.env.WGER_CLIENT_ID = "id";
    expect(new WgerProvider().validate()).toContain("WGER_CLIENT_SECRET");
    process.env.WGER_CLIENT_SECRET = "secret";
    expect(new WgerProvider().validate()).toBeNull();
  });

  it("authSetup returns config", () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    const setup = new WgerProvider().authSetup();
    expect(setup.oauthConfig?.clientId).toBe("id");
    expect(setup.apiBaseUrl).toContain("wger.de");
  });

  it("authSetup throws when env vars missing", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(() => new WgerProvider().authSetup()).toThrow();
  });

  it("sync returns error when no tokens", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    vi.mocked(loadTokens).mockResolvedValueOnce(null);
    const mockFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("fetch should not be called when tokens are missing");
    });
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
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips workout sessions after the sync window end", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({
          count: 2,
          next: null,
          previous: null,
          results: [
            {
              id: 10,
              date: "2026-03-01",
              comment: "In Window",
              impression: "2",
              time_start: "09:00",
              time_end: "10:00",
            },
            {
              id: 20,
              date: "2026-03-03",
              comment: "After Window",
              impression: "2",
              time_start: "09:00",
              time_end: "10:00",
            },
          ],
        });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "10" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "20" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["10"]),
      }),
    );
  });

  it("handles repeated workout session pagination next URLs without hanging", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const repeatedUrl =
      "https://wger.de/api/v2/workoutsession/?format=json&ordering=-date&offset=0&limit=50";
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      callCount++;
      if (url.includes("/workoutsession/")) {
        return Response.json({
          count: 2,
          next: repeatedUrl,
          previous: null,
          results: [
            {
              id: 10,
              date: "2026-03-01",
              comment: "In Window",
              impression: "2",
              time_start: "09:00",
              time_end: "10:00",
            },
          ],
        });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(3);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("skips weight entries outside the bounded sync window", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";

    const { writeMetricStreamBatch } = await import("../db/metric-stream-writer.ts");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 3,
          next: null,
          previous: null,
          results: [
            { id: 1, date: "2026-03-02", weight: "80.0" },
            { id: 2, date: "2026-03-01", weight: "79.5" },
            { id: 3, date: "2026-03-03", weight: "81.0" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-02" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(writeMetricStreamBatch).toHaveBeenCalledTimes(2);
    expect(writeMetricStreamBatch).toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ externalId: "1" })],
      expect.any(String),
      undefined,
      undefined,
    );
    expect(writeMetricStreamBatch).toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ externalId: "2" })],
      expect.any(String),
      undefined,
      undefined,
    );
    expect(writeMetricStreamBatch).not.toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ externalId: "3" })],
      expect.any(String),
      undefined,
      undefined,
    );
  });

  it("retains weight entries when pagination stalls on a repeated next URL", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";

    const repeatedNextUrl = "https://wger.de/api/v2/weightentry/?offset=50";
    let weightRequests = 0;

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes("/weightentry/")) {
        weightRequests += 1;
        return Response.json({
          count: 2,
          next: repeatedNextUrl,
          previous: null,
          results: [
            { id: 1, date: "2026-03-02", weight: "80.0" },
            { id: 2, date: "2026-03-01", weight: "79.5" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new WgerProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01") }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(weightRequests).toBe(2);
    expect(result.recordsSynced).toBe(4);
  });

  it("captures weight write errors without aborting the whole sync", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";

    const { writeMetricStreamBatch } = await import("../db/metric-stream-writer.ts");
    vi.mocked(writeMetricStreamBatch)
      .mockRejectedValueOnce(new Error("weight write failed"))
      .mockResolvedValue(1);

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 2,
          next: null,
          previous: null,
          results: [
            { id: 1, date: "2026-03-02", weight: "80.0" },
            { id: 2, date: "2026-03-01", weight: "79.5" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new WgerProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01") }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.externalId).toBe("1");
    expect(result.recordsSynced).toBe(1);
  });
});

describe("WgerProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'wger'", async () => {
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new WgerProvider(mockFetch);
    const setup = provider.authSetup();
    expect(setup.exchangeCode).toBeTypeOf("function");
    if (!setup.exchangeCode) throw new Error("expected exchangeCode");
    const err = await setup.exchangeCode("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("wger");
      expect(err.statusCode).toBe(429);
    }
  });
});
