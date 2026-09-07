import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { loadTokens } from "../db/tokens.ts";
import {
  DecathlonProvider,
  decathlonOAuthConfig,
  mapDecathlonSport,
  parseDecathlonActivity,
} from "./decathlon.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

interface CapturedSyncLogOutcome {
  dataType: string;
  degradations?: Array<{ kind: string; context?: unknown }>;
}

const syncLogOutcomes = vi.hoisted<{ values: CapturedSyncLogOutcome[] }>(() => ({
  values: [],
}));

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{
        recordCount: number;
        result: unknown;
        degradations?: Array<{ kind: string; context?: unknown }>;
      }>,
    ) => {
      const outcome = await fn();
      syncLogOutcomes.values.push({ dataType: _dataType, degradations: outcome.degradations });
      return outcome.result;
    },
  ),
}));

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "decathlon"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  })),
  saveTokens: vi.fn(async () => {}),
  deleteTokens: vi.fn(async () => {}),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

function createMockDb() {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };

  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }

  const db: SyncDatabase = {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue(chain),
    delete: vi.fn(),
    execute: vi.fn(),
  };

  return Object.assign(db, chain);
}

describe("DecathlonProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
    syncLogOutcomes.values = [];
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'decathlon'", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new DecathlonProvider(mockFetch);
    const setup = provider.authSetup();

    const err = await setup.exchangeCode?.("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("decathlon");
      expect(err.statusCode).toBe(429);
    }
  });

  it("skips activities after the sync window end", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/activities")) {
        return Response.json({
          data: [
            {
              id: "in-window",
              name: "Run",
              sport: "/v2/sports/381",
              startdate: "2026-03-01T08:00:00Z",
              duration: 3600,
              dataSummaries: [],
            },
            {
              id: "after-window",
              name: "Run",
              sport: "/v2/sports/381",
              startdate: "2026-03-03T08:00:00Z",
              duration: 3600,
              dataSummaries: [],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "in-window" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "after-window" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["in-window"]),
      }),
    );
  });

  it("treats null data as an empty page", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () => Response.json({ data: null });

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("handles repeated links.next without hanging", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();

    const repeatedUrl =
      "https://api.decathlon.net/sportstrackingdata/v2/activities?after=2026-03-01T00%3A00%3A00.000Z&limit=50";
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++;
      return Response.json({
        data: [
          {
            id: "act-1",
            name: "Run",
            sport: "/v2/sports/381",
            startdate: "2026-03-01T08:00:00Z",
            duration: 3600,
            dataSummaries: [],
          },
        ],
        links: { next: repeatedUrl },
      });
    };

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(2);
    expect(syncLogOutcomes.values).toContainEqual({
      dataType: "activity",
      degradations: [
        expect.objectContaining({
          kind: "pagination_stalled",
          context: expect.objectContaining({
            cursorFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
            pagesFetched: 2,
          }),
        }),
      ],
    });
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("reports API errors during activity sync", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/activities")) {
        return new Response("server error", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    };

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Decathlon API error (500)");
    expect(result.recordsSynced).toBe(0);
  });

  it("skips activities after the exact sync window end boundary", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/activities")) {
        return Response.json({
          data: [
            {
              id: "after-boundary",
              name: "Run",
              sport: "/v2/sports/381",
              startdate: "2026-03-02T00:00:00.001Z",
              duration: 0,
              dataSummaries: [],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-03-01",
          untilDate: "2026-03-01",
        }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalled();
  });

  it("includes activities exactly at the sync window end boundary", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/activities")) {
        return Response.json({
          data: [
            {
              id: "at-boundary",
              name: "Run",
              sport: "/v2/sports/381",
              startdate: "2026-03-01T23:59:59.999Z",
              duration: 0,
              dataSummaries: [],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-03-01",
          untilDate: "2026-03-01",
        }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
  });

  it("rejects malformed activity dates at the API boundary", async () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({
        data: [
          {
            id: "bad-date",
            name: "Run",
            sport: "/v2/sports/381",
            startdate: "not-a-date",
            duration: 3600,
            dataSummaries: [],
          },
        ],
      });

    const db = createMockDb();
    const result = await new DecathlonProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("activity:");
  });
});

describe("mapDecathlonSport — all types", () => {
  it("maps known sport IDs from URI", () => {
    expect(mapDecathlonSport("/v2/sports/381").canonicalType).toBe("running");
    expect(mapDecathlonSport("/v2/sports/121").canonicalType).toBe("cycling");
    expect(mapDecathlonSport("/v2/sports/153").canonicalType).toBe("cycling");
    expect(mapDecathlonSport("/v2/sports/320").canonicalType).toBe("walking");
    expect(mapDecathlonSport("/v2/sports/110").canonicalType).toBe("hiking");
    expect(mapDecathlonSport("/v2/sports/274").canonicalType).toBe("running");
    expect(mapDecathlonSport("/v2/sports/260").canonicalType).toBe("swimming");
    expect(mapDecathlonSport("/v2/sports/79").canonicalType).toBe("skiing");
    expect(mapDecathlonSport("/v2/sports/173").canonicalType).toBe("rowing");
    expect(mapDecathlonSport("/v2/sports/263").canonicalType).toBe("swimming");
    expect(mapDecathlonSport("/v2/sports/91").canonicalType).toBe("skiing");
    expect(mapDecathlonSport("/v2/sports/174").canonicalType).toBe("rowing");
    expect(mapDecathlonSport("/v2/sports/395").canonicalType).toBe("yoga");
    expect(mapDecathlonSport("/v2/sports/105").canonicalType).toBe("strength");
    expect(mapDecathlonSport("/v2/sports/264").canonicalType).toBe("triathlon");
    expect(mapDecathlonSport("/v2/sports/292").canonicalType).toBe("skating");
    expect(mapDecathlonSport("/v2/sports/160").canonicalType).toBe("climbing");
    expect(mapDecathlonSport("/v2/sports/100").canonicalType).toBe("cross_training");
    expect(mapDecathlonSport("/v2/sports/367").canonicalType).toBe("elliptical");
    expect(mapDecathlonSport("/v2/sports/176").canonicalType).toBe("strength");
  });

  it("returns other for unknown sport ID", () => {
    expect(mapDecathlonSport("/v2/sports/999").canonicalType).toBe("other");
    expect(mapDecathlonSport("").canonicalType).toBe("other");
    expect(mapDecathlonSport("   ")).toEqual({
      canonicalType: "other",
      modality: null,
      providerType: "other",
    });
  });
});

describe("parseDecathlonActivity", () => {
  it("parses activity with data summaries", () => {
    const act = {
      id: "dec-123",
      name: "Morning Run",
      sport: "/v2/sports/381",
      startdate: "2026-03-01T08:00:00Z",
      duration: 3600,
      dataSummaries: [
        { id: 5, value: 10 },
        { id: 9, value: 500 },
        { id: 1, value: 150 },
        { id: 2, value: 175 },
      ],
    };

    const parsed = parseDecathlonActivity(act);
    expect(parsed.externalId).toBe("dec-123");
    expect(parsed.activityType.canonicalType).toBe("running");
    expect(parsed.name).toBe("Morning Run");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date(new Date("2026-03-01T08:00:00Z").getTime() + 3600000));
    expect(parsed.raw.distanceKm).toBe(10);
    expect(parsed.raw.avgHeartRate).toBe(150);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.dataSummaries).toEqual(act.dataSummaries);
  });

  it("handles empty dataSummaries", () => {
    const act = {
      id: "dec-min",
      name: "Walk",
      sport: "/v2/sports/320",
      startdate: "2026-03-01T12:00:00Z",
      duration: 1800,
      dataSummaries: [],
    };

    const parsed = parseDecathlonActivity(act);
    expect(parsed.raw.distanceKm).toBeUndefined();
  });
});

describe("decathlonOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when missing", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(decathlonOAuthConfig()).toBeNull();
  });

  it("returns null when DECATHLON_CLIENT_SECRET is not set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(decathlonOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.DECATHLON_CLIENT_ID = "id";
    process.env.DECATHLON_CLIENT_SECRET = "secret";
    const config = decathlonOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("decathlon.net");
  });

  it("returns config with scopes when both env vars are set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    const config = decathlonOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("openid");
    expect(config?.scopes).toContain("profile");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = decathlonOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = decathlonOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.fit/callback");
  });
});

describe("DecathlonProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate checks env vars", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    expect(new DecathlonProvider().validate()).toContain("DECATHLON_CLIENT_ID");
    process.env.DECATHLON_CLIENT_ID = "id";
    expect(new DecathlonProvider().validate()).toContain("DECATHLON_CLIENT_SECRET");
    process.env.DECATHLON_CLIENT_SECRET = "secret";
    expect(new DecathlonProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.DECATHLON_CLIENT_ID = "id";
    process.env.DECATHLON_CLIENT_SECRET = "secret";
    vi.mocked(loadTokens).mockResolvedValueOnce(null);
    const db = createMockDb();
    const result = await new DecathlonProvider().sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("DecathlonProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.DECATHLON_CLIENT_ID = "test-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-secret";
    const provider = new DecathlonProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("decathlon.net");
  });

  it("throws when env vars are missing", () => {
    delete process.env.DECATHLON_CLIENT_ID;
    delete process.env.DECATHLON_CLIENT_SECRET;
    const provider = new DecathlonProvider();
    expect(() => provider.authSetup()).toThrow("DECATHLON_CLIENT_ID");
  });
});
