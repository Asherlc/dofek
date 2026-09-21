import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import type { Database, SyncDatabase } from "../../db/index.ts";
import { ProviderAuthorizationFailedError, RefreshTokenRevokedError } from "../auth-errors.ts";
import type { SyncCheckpointStore } from "../sync-run.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import {
  ZivaMcpClient,
  ZivaMcpMalformedResponseError,
  ZivaMcpToolError,
  ZivaMcpTransportError,
} from "./client.ts";
import { ZivaProvider } from "./provider.ts";
import { createFakeZivaMcpHarness, type FakeZivaMcpHarness } from "./test-helpers.ts";

vi.mock("../../db/tokens.ts", () => ({
  deleteTokens: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("./nutrition-writer.ts", () => ({
  upsertZivaMealsForDate: vi.fn(),
}));

vi.mock("../../lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));

const { deleteTokens, loadTokens, saveTokens } = await import("../../db/tokens.ts");
const { captureException } = await import("../../lib/error-reporting.ts");
const { upsertZivaMealsForDate } = await import("./nutrition-writer.ts");

const mockDeleteTokens = vi.mocked(deleteTokens);
const mockLoadTokens = vi.mocked(loadTokens);
const mockSaveTokens = vi.mocked(saveTokens);
const mockCaptureException = vi.mocked(captureException);
const mockUpsertZivaMealsForDate = vi.mocked(upsertZivaMealsForDate);

const ZIVA_ISSUER = "https://connect.ziva.fit/";
const ZIVA_RESOURCE = "https://connect.ziva.fit/mcp";
const FIRST_DATE = "2026-09-19";
const SECOND_DATE = "2026-09-20";

function jwt(subject: string, overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: subject, ...overrides }),
  ).toString("base64url");
  return `${header}.${claims}.synthetic-signature`;
}

function tokenSet(subject = "subject-a", overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: jwt(subject),
    refreshToken: "refresh-a",
    expiresAt: new Date(Date.now() + 3_600_000),
    providerAccountId: subject,
    scopes: null,
    ...overrides,
  };
}

function meal(date: string, id = `meal-${date}`, overrides: Record<string, unknown> = {}) {
  return {
    mealId: id,
    description: `Meal for ${date}`,
    mealDate: date,
    items: [
      {
        food: `Food for ${date}`,
        portion: "one serving",
        gramWeight: 125,
        quantity: 1,
      },
    ],
    macros: { protein: 20, fat: 10, carbs: 30, calories: 300 },
    itemCount: 1,
    mealType: "lunch",
    mealTime: "12:00",
    createdAt: `${date}T12:00:00Z`,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallDate(value: unknown): string | null {
  if (!isRecord(value) || value.method !== "tools/call" || !isRecord(value.params)) return null;
  if (!isRecord(value.params.arguments)) return null;
  return typeof value.params.arguments.start_date === "string"
    ? value.params.arguments.start_date
    : null;
}

interface DateProtocolHarness {
  readonly harness: FakeZivaMcpHarness;
  readonly fetch: typeof globalThis.fetch;
  readonly requestedDates: string[];
}

function createDateProtocolHarness(
  resultForDate: (date: string) => Record<string, unknown> | Response,
): DateProtocolHarness {
  const mutableCallResult: Record<string, unknown> = {};
  const harness = createFakeZivaMcpHarness({ callResult: mutableCallResult });
  const requestedDates: string[] = [];
  const protocolFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      const requestBody: unknown = await request.clone().json();
      const date = toolCallDate(requestBody);
      if (date) {
        requestedDates.push(date);
        const result = resultForDate(date);
        if (result instanceof Response) return result;
        for (const key of Object.keys(mutableCallResult)) delete mutableCallResult[key];
        Object.assign(mutableCallResult, result);
      }
    }
    return harness.fetch(request);
  };
  return { harness, fetch: protocolFetch, requestedDates };
}

function successfulDateHarness(
  mealsForDate: (date: string) => Array<Record<string, unknown>> = (date) => [meal(date)],
): DateProtocolHarness {
  return createDateProtocolHarness((date) => ({
    content: [],
    structuredContent: { meals: mealsForDate(date) },
  }));
}

interface RoutedFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly tokenRequests: URLSearchParams[];
}

function routeFetch(options: {
  mcpByBearer: Map<string, typeof globalThis.fetch>;
  tokenResponse?: () => Response;
}): RoutedFetch {
  const tokenRequests: URLSearchParams[] = [];
  const routedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://connect.ziva.fit/token") {
      tokenRequests.push(new URLSearchParams(await request.text()));
      return (
        options.tokenResponse?.() ??
        Response.json({
          access_token: jwt("subject-a"),
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        })
      );
    }
    const bearer = request.headers.get("authorization") ?? "";
    const mcpFetch = options.mcpByBearer.get(bearer);
    if (!mcpFetch) throw new Error(`Unexpected bearer route: ${bearer}`);
    return mcpFetch(request);
  };
  return { fetch: routedFetch, tokenRequests };
}

function fakeDatabase(): SyncDatabase & Pick<Database, "transaction"> {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
}

function nonTransactionalDatabase(): SyncDatabase {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  };
}

class MemoryCheckpointStore implements SyncCheckpointStore {
  value: unknown | null;
  readonly saved: unknown[] = [];
  clearCount = 0;
  loadFailure: Error | null = null;
  saveFailure: Error | null = null;
  clearFailure: Error | null = null;

  constructor(value: unknown | null = null) {
    this.value = value;
  }

  async load(): Promise<unknown | null> {
    if (this.loadFailure) throw this.loadFailure;
    return this.value;
  }

  async save(checkpoint: unknown): Promise<void> {
    if (this.saveFailure) throw this.saveFailure;
    this.value = checkpoint;
    this.saved.push(checkpoint);
  }

  async clear(): Promise<void> {
    if (this.clearFailure) throw this.clearFailure;
    this.value = null;
    this.clearCount += 1;
  }
}

function syncRun(
  options: {
    db?: SyncDatabase;
    sinceDate?: string;
    untilDate?: string;
    userId?: string;
    checkpoint?: SyncCheckpointStore;
    enqueueSyncContinuation?: (checkpoint: unknown) => Promise<void>;
    onProgress?: (percentage: number, message: string) => void;
  } = {},
): SyncRun {
  return new SyncRun({
    db: options.db ?? fakeDatabase(),
    window: SyncWindow.fromDateRange({
      sinceDate: options.sinceDate ?? FIRST_DATE,
      untilDate: options.untilDate ?? SECOND_DATE,
    }),
    userId: options.userId === undefined ? "user-a" : options.userId,
    checkpoint: options.checkpoint ?? new MemoryCheckpointStore(),
    enqueueSyncContinuation: options.enqueueSyncContinuation ?? (async (_checkpoint) => undefined),
    onProgress: options.onProgress,
  });
}

function authenticationFailureHarness(
  phase: "initialize" | "tools/list" | "tools/call",
): FakeZivaMcpHarness {
  const error = { status: 401, body: "private authentication response" };
  if (phase === "initialize") {
    return createFakeZivaMcpHarness({ httpErrors: { initialize: error } });
  }
  if (phase === "tools/list") {
    return createFakeZivaMcpHarness({ httpErrors: { "tools/list": error } });
  }
  return createFakeZivaMcpHarness({ httpErrors: { "tools/call": error } });
}

interface MissingPrerequisite {
  readonly userId?: string;
  readonly db?: SyncDatabase;
  readonly checkpoint?: SyncCheckpointStore;
  readonly enqueueSyncContinuation?: (checkpoint: unknown) => Promise<void>;
}

const missingPrerequisites: ReadonlyArray<readonly [string, MissingPrerequisite]> = [
  ["user ID", { userId: "" }],
  ["transaction-capable database", { db: nonTransactionalDatabase() }],
  ["checkpoint store", { checkpoint: undefined }],
  ["continuation enqueue", { enqueueSyncContinuation: undefined }],
];

describe("ZivaProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ZIVA_CLIENT_ID", "ziva-client-id");
    vi.stubEnv("ZIVA_CLIENT_SECRET", "ziva-client-secret");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
    mockLoadTokens.mockResolvedValue(tokenSet());
    mockSaveTokens.mockResolvedValue(undefined);
    mockDeleteTokens.mockResolvedValue(undefined);
    mockUpsertZivaMealsForDate.mockImplementation(async (_db, _userId, meals) => meals.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exposes the configured OAuth setup and one-day scheduled lookback", () => {
    const provider = new ZivaProvider();

    expect(provider.id).toBe("ziva");
    expect(provider.name).toBe("Ziva");
    expect(provider.scheduledSyncLookbackDays).toBe(1);
    expect(provider.validate()).toBeNull();
    expect(provider.authSetup()?.oauthConfig).toMatchObject({
      tokenUrl: "https://connect.ziva.fit/token",
      resource: ZIVA_RESOURCE,
      scopes: [],
    });

    delete process.env.ZIVA_CLIENT_SECRET;
    expect(provider.validate()).toBe("ZIVA_CLIENT_SECRET is not set");
    expect(provider.authSetup()).toBeUndefined();
  });

  it.each(missingPrerequisites)(
    "fails before network access without a required %s",
    async (_label, missing) => {
      const harness = successfulDateHarness();
      const run = new SyncRun({
        db: missing.db ?? fakeDatabase(),
        window: SyncWindow.fromDateRange({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
        userId: missing.userId === undefined ? "user-a" : missing.userId,
        checkpoint: "checkpoint" in missing ? missing.checkpoint : new MemoryCheckpointStore(),
        enqueueSyncContinuation:
          "enqueueSyncContinuation" in missing
            ? missing.enqueueSyncContinuation
            : async (_checkpoint) => undefined,
      });

      await expect(new ZivaProvider(harness.fetch).sync(run)).rejects.toThrow();
      expect(mockLoadTokens).not.toHaveBeenCalled();
      expect(harness.harness.jsonRpcMethods).toEqual([]);
    },
  );

  it("commits two dates, saves only post-commit checkpoints, and reports chunk progress", async () => {
    const protocol = successfulDateHarness((date) =>
      date === FIRST_DATE ? [meal(date)] : [meal(date, "second-a"), meal(date, "second-b")],
    );
    const checkpoint = new MemoryCheckpointStore();
    const progress: number[] = [];
    const result = await new ZivaProvider(protocol.fetch).sync(
      syncRun({
        checkpoint,
        onProgress: (percentage) => progress.push(percentage),
      }),
    );

    expect(result).toMatchObject({
      provider: "ziva",
      recordsSynced: 3,
      errors: [],
      continued: false,
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(mockUpsertZivaMealsForDate).toHaveBeenCalledTimes(2);
    expect(mockUpsertZivaMealsForDate.mock.calls.map((call) => call[2].length)).toEqual([1, 2]);
    expect(checkpoint.saved).toEqual([
      { version: 1, nextDate: SECOND_DATE, endDate: SECOND_DATE, recordsSynced: 1 },
    ]);
    expect(checkpoint.clearCount).toBe(1);
    expect(progress).toEqual([50, 100]);
    expect(protocol.requestedDates).toEqual([FIRST_DATE, SECOND_DATE]);
    expect(protocol.harness.transportClosed).toBe(true);
  });

  it("continues a 15-date window with one durable enqueue and cumulative counts", async () => {
    const protocol = successfulDateHarness();
    const checkpoint = new MemoryCheckpointStore();
    const continuations: unknown[] = [];
    const provider = new ZivaProvider(protocol.fetch);
    const enqueueSyncContinuation = async (nextCheckpoint: unknown) => {
      continuations.push(nextCheckpoint);
    };

    const first = await provider.sync(
      syncRun({
        sinceDate: "2026-01-01",
        untilDate: "2026-01-15",
        checkpoint,
        enqueueSyncContinuation,
      }),
    );

    expect(first).toMatchObject({ recordsSynced: 14, errors: [], continued: true });
    expect(continuations).toEqual([
      { version: 1, nextDate: "2026-01-15", endDate: "2026-01-15", recordsSynced: 14 },
    ]);
    expect(checkpoint.saved).toHaveLength(14);
    expect(checkpoint.value).toEqual(continuations[0]);

    const second = await provider.sync(
      syncRun({
        sinceDate: "2026-01-01",
        untilDate: "2026-01-15",
        checkpoint,
        enqueueSyncContinuation,
      }),
    );

    expect(second).toMatchObject({ recordsSynced: 15, errors: [], continued: false });
    expect(checkpoint.clearCount).toBe(1);
    expect(continuations).toHaveLength(1);
  });

  it.each([
    [
      "an incomplete macro set",
      () => [meal(FIRST_DATE, "incomplete", { macros: { protein: 1, fat: 2, carbs: 3 } })],
    ],
    ["a cross-date meal", () => [meal(SECOND_DATE, "cross-date")]],
    ["a duplicate meal ID", () => [meal(FIRST_DATE, "duplicate"), meal(FIRST_DATE, "duplicate")]],
  ])(
    "returns a terminal schema error without writes or advancement for %s",
    async (_case, meals) => {
      const protocol = successfulDateHarness(() => meals());
      const checkpoint = new MemoryCheckpointStore();
      const result = await new ZivaProvider(protocol.fetch).sync(
        syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE, checkpoint }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.continued).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.cause).toBeInstanceOf(ZivaMcpMalformedResponseError);
      expect(mockUpsertZivaMealsForDate).not.toHaveBeenCalled();
      expect(checkpoint.saved).toEqual([]);
      expect(checkpoint.clearCount).toBe(0);
    },
  );

  it("keeps the first commit/count/checkpoint when the second date fails", async () => {
    const protocol = successfulDateHarness((date) =>
      date === FIRST_DATE
        ? [meal(date)]
        : [meal(date, "bad", { macros: { protein: 1, fat: 2, carbs: 3 } })],
    );
    const checkpoint = new MemoryCheckpointStore();
    const result = await new ZivaProvider(protocol.fetch).sync(syncRun({ checkpoint }));

    expect(result).toMatchObject({ recordsSynced: 1, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(ZivaMcpMalformedResponseError);
    expect(mockUpsertZivaMealsForDate).toHaveBeenCalledTimes(1);
    expect(checkpoint.value).toEqual({
      version: 1,
      nextDate: SECOND_DATE,
      endDate: SECOND_DATE,
      recordsSynced: 1,
    });
    expect(checkpoint.clearCount).toBe(0);
  });

  it("returns tool, provider-timeout, and service failures as terminal errors", async () => {
    const cases = [
      {
        harness: createFakeZivaMcpHarness({
          callResult: { isError: true, content: [{ type: "text", text: "private" }] },
        }),
        errorType: ZivaMcpToolError,
      },
      {
        harness: createFakeZivaMcpHarness({
          thrownErrors: {
            "tools/call": new ProviderRequestTimeoutError({
              providerId: "ziva",
              timeoutMs: 120_000,
            }),
          },
        }),
        errorType: ProviderRequestTimeoutError,
      },
      {
        harness: createFakeZivaMcpHarness({
          httpErrors: { "tools/call": { status: 503, body: "private outage" } },
        }),
        errorType: ProviderServiceUnavailableError,
      },
    ];

    for (const { harness, errorType } of cases) {
      const result = await new ZivaProvider(harness.fetch).sync(
        syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
      );
      expect(result).toMatchObject({ recordsSynced: 0, continued: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.cause).toBeInstanceOf(errorType);
    }
  });

  it("lets provider rate limits escape for worker scheduling", async () => {
    const harness = createFakeZivaMcpHarness({
      httpErrors: {
        "tools/call": {
          status: 429,
          body: "private rate-limit response",
          headers: { "Retry-After": "30" },
        },
      },
    });

    await expect(
      new ZivaProvider(harness.fetch).sync(
        syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
      ),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it.each(["write", "checkpoint save", "checkpoint clear", "continuation enqueue"])(
    "lets %s infrastructure failures escape",
    async (phase) => {
      const protocol = successfulDateHarness();
      const checkpoint = new MemoryCheckpointStore();
      const failure = new Error(`${phase} unavailable`);
      if (phase === "write") mockUpsertZivaMealsForDate.mockRejectedValueOnce(failure);
      if (phase === "checkpoint save") checkpoint.saveFailure = failure;
      if (phase === "checkpoint clear") checkpoint.clearFailure = failure;
      const enqueueSyncContinuation = async (_next: unknown) => {
        if (phase === "continuation enqueue") throw failure;
      };
      const isContinuation = phase === "continuation enqueue";

      await expect(
        new ZivaProvider(protocol.fetch).sync(
          syncRun({
            sinceDate: isContinuation ? "2026-01-01" : FIRST_DATE,
            untilDate: isContinuation ? "2026-01-15" : SECOND_DATE,
            checkpoint,
            enqueueSyncContinuation,
          }),
        ),
      ).rejects.toBe(failure);

      if (phase === "write") expect(checkpoint.saved).toEqual([]);
      if (phase === "continuation enqueue") {
        expect(checkpoint.value).toEqual({
          version: 1,
          nextDate: "2026-01-15",
          endDate: "2026-01-15",
          recordsSynced: 14,
        });
      }
    },
  );

  it.each(["load", "delete"] as const)(
    "lets token repository %s failures escape",
    async (operation) => {
      const failure = new Error(`token ${operation} unavailable`);
      if (operation === "load") mockLoadTokens.mockRejectedValueOnce(failure);
      if (operation === "delete") {
        mockLoadTokens.mockResolvedValueOnce(tokenSet("subject-a", { accessToken: "malformed" }));
        mockDeleteTokens.mockRejectedValueOnce(failure);
      }

      await expect(
        new ZivaProvider(vi.fn<typeof globalThis.fetch>()).sync(
          syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
        ),
      ).rejects.toBe(failure);
    },
  );

  it("refreshes an expired malformed access token before validating the resolved identity", async () => {
    const malformedExpired = tokenSet("subject-a", {
      accessToken: "malformed-expired-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    const refreshedAccessToken = jwt("subject-a");
    const protocol = successfulDateHarness();
    const routed = routeFetch({
      mcpByBearer: new Map([[`Bearer ${refreshedAccessToken}`, protocol.fetch]]),
      tokenResponse: () =>
        Response.json({
          access_token: refreshedAccessToken,
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
    });
    mockLoadTokens.mockResolvedValue(malformedExpired);

    const result = await new ZivaProvider(routed.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(routed.tokenRequests).toHaveLength(1);
    expect(mockDeleteTokens).not.toHaveBeenCalled();
  });

  it("deletes an expired credential without a refresh token and returns revoked", async () => {
    mockLoadTokens.mockResolvedValue(
      tokenSet("subject-a", {
        refreshToken: null,
        expiresAt: new Date(Date.now() - 1_000),
      }),
    );
    const fetchFn = vi.fn<typeof globalThis.fetch>();

    const result = await new ZivaProvider(fetchFn).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result).toMatchObject({ recordsSynced: 0, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(mockDeleteTokens).toHaveBeenCalledWith(expect.anything(), "ziva");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JWT", { accessToken: "not-a-jwt" }],
    ["wrong issuer", { accessToken: jwt("subject-a", { iss: "https://wrong.example/" }) }],
    ["wrong audience", { accessToken: jwt("subject-a", { aud: "https://wrong.example/mcp" }) }],
    ["changed subject", { accessToken: jwt("subject-b") }],
    ["missing stored account", { providerAccountId: undefined }],
    ["blank stored account", { providerAccountId: "   " }],
  ])("deletes an unexpired credential with %s and returns reconnect", async (_case, overrides) => {
    mockLoadTokens.mockResolvedValue(tokenSet("subject-a", overrides));
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const result = await new ZivaProvider(fetchFn).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result).toMatchObject({ recordsSynced: 0, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(ProviderAuthorizationFailedError);
    expect(mockDeleteTokens).toHaveBeenCalledWith(expect.anything(), "ziva");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["initialize", "tools/list", "tools/call"] as const)(
    "refreshes exactly once after a 401 during %s and retries the same date with a new client",
    async (phase) => {
      const current = tokenSet();
      const rotatedAccessToken = jwt("subject-a", { jti: "rotated-after-401" });
      const rejected = authenticationFailureHarness(phase);
      const accepted = successfulDateHarness();
      const routed = routeFetch({
        mcpByBearer: new Map([
          [`Bearer ${current.accessToken}`, rejected.fetch],
          [`Bearer ${rotatedAccessToken}`, accepted.fetch],
        ]),
        tokenResponse: () =>
          Response.json({
            access_token: rotatedAccessToken,
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          }),
      });
      mockLoadTokens.mockResolvedValue(current);

      const result = await new ZivaProvider(routed.fetch).sync(
        syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
      );

      expect(result).toMatchObject({ recordsSynced: 1, errors: [], continued: false });
      expect(routed.tokenRequests).toHaveLength(1);
      expect(routed.tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
      expect(mockSaveTokens).toHaveBeenCalledWith(
        expect.anything(),
        "ziva",
        expect.objectContaining({
          accessToken: rotatedAccessToken,
          refreshToken: "rotated-refresh",
          providerAccountId: "subject-a",
        }),
      );
      expect(mockDeleteTokens).not.toHaveBeenCalled();
      expect(accepted.requestedDates).toEqual([FIRST_DATE]);
      expect(rejected.transportClosed).toBe(true);
      expect(accepted.harness.transportClosed).toBe(true);
    },
  );

  it("deletes credentials and returns revoked when the first 401 has no refresh token", async () => {
    const current = tokenSet("subject-a", { refreshToken: null });
    const rejected = authenticationFailureHarness("tools/call");
    mockLoadTokens.mockResolvedValue(current);
    const result = await new ZivaProvider(rejected.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result.errors[0]?.cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(mockDeleteTokens).toHaveBeenCalledWith(expect.anything(), "ziva");
    expect(mockSaveTokens).not.toHaveBeenCalled();
  });

  it.each([
    [
      "changed subject",
      () =>
        Response.json({
          access_token: jwt("subject-b"),
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
    ],
    [
      "malformed subject token",
      () =>
        Response.json({
          access_token: "malformed-refreshed-token",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
    ],
  ] as const)("deletes credentials when refresh returns a %s", async (_case, tokenResponse) => {
    const current = tokenSet();
    const rejected = authenticationFailureHarness("tools/call");
    const routed = routeFetch({
      mcpByBearer: new Map([[`Bearer ${current.accessToken}`, rejected.fetch]]),
      tokenResponse,
    });
    mockLoadTokens.mockResolvedValue(current);

    const result = await new ZivaProvider(routed.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result.errors[0]?.cause).toBeInstanceOf(ProviderAuthorizationFailedError);
    expect(mockDeleteTokens).toHaveBeenCalledWith(expect.anything(), "ziva");
    expect(mockSaveTokens).not.toHaveBeenCalled();
  });

  it("keeps invalid_grant as the shared revoked/reconnect result without an MCP retry", async () => {
    const current = tokenSet();
    const rejected = authenticationFailureHarness("tools/call");
    const routed = routeFetch({
      mcpByBearer: new Map([[`Bearer ${current.accessToken}`, rejected.fetch]]),
      tokenResponse: () =>
        Response.json(
          { error: "invalid_grant", error_description: "refresh token revoked" },
          { status: 400 },
        ),
    });
    mockLoadTokens.mockResolvedValue(current);

    const result = await new ZivaProvider(routed.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result.errors[0]?.cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(mockDeleteTokens).toHaveBeenCalledTimes(1);
    expect(mockSaveTokens).not.toHaveBeenCalled();
    expect(routed.tokenRequests).toHaveLength(1);
  });

  it("uses one refresh budget across dates and revokes credentials on the second 401", async () => {
    const current = tokenSet();
    const rotatedAccessToken = jwt("subject-a", { jti: "rotated-after-first-401" });
    const currentProtocol = createDateProtocolHarness((date) =>
      date === FIRST_DATE
        ? { content: [], structuredContent: { meals: [meal(date)] } }
        : new Response("expired", { status: 401 }),
    );
    const rotatedProtocol = createDateProtocolHarness(
      () => new Response("still expired", { status: 401 }),
    );
    const routed = routeFetch({
      mcpByBearer: new Map([
        [`Bearer ${current.accessToken}`, currentProtocol.fetch],
        [`Bearer ${rotatedAccessToken}`, rotatedProtocol.fetch],
      ]),
      tokenResponse: () =>
        Response.json({
          access_token: rotatedAccessToken,
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
    });
    const checkpoint = new MemoryCheckpointStore();
    mockLoadTokens.mockResolvedValue(current);

    const result = await new ZivaProvider(routed.fetch).sync(syncRun({ checkpoint }));

    expect(result).toMatchObject({ recordsSynced: 1, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(routed.tokenRequests).toHaveLength(1);
    expect(mockDeleteTokens).toHaveBeenCalledWith(expect.anything(), "ziva");
    expect(checkpoint.value).toEqual({
      version: 1,
      nextDate: SECOND_DATE,
      endDate: SECOND_DATE,
      recordsSynced: 1,
    });
  });

  it("reports a close-only failure as terminal after preserving the committed count", async () => {
    const protocol = successfulDateHarness();
    vi.spyOn(ZivaMcpClient.prototype, "close").mockRejectedValueOnce(
      new Error("private close failure"),
    );

    const result = await new ZivaProvider(protocol.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result).toMatchObject({ recordsSynced: 1, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(ZivaMcpTransportError);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(ZivaMcpTransportError),
      expect.objectContaining({ tags: { provider: "ziva", mcpPhase: "close" } }),
    );
    expect(result.errors[0]?.message).not.toContain("private close failure");
  });

  it("does not let close failure mask a primary tool failure", async () => {
    const protocol = createFakeZivaMcpHarness({
      callResult: { isError: true, content: [{ type: "text", text: "private" }] },
    });
    vi.spyOn(ZivaMcpClient.prototype, "close").mockRejectedValueOnce(
      new Error("private close failure"),
    );

    const result = await new ZivaProvider(protocol.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result.errors[0]?.cause).toBeInstanceOf(ZivaMcpToolError);
    expect(result.errors[0]?.cause).not.toBeInstanceOf(ZivaMcpTransportError);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("closes before continuation and never enqueues after a close failure", async () => {
    const protocol = successfulDateHarness(() => []);
    const checkpoint = new MemoryCheckpointStore();
    const enqueueSyncContinuation = vi.fn(async (_next: unknown) => undefined);
    vi.spyOn(ZivaMcpClient.prototype, "close").mockRejectedValueOnce(new Error("close failed"));

    const result = await new ZivaProvider(protocol.fetch).sync(
      syncRun({
        sinceDate: "2026-01-01",
        untilDate: "2026-01-15",
        checkpoint,
        enqueueSyncContinuation,
      }),
    );

    expect(result).toMatchObject({ recordsSynced: 0, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(ZivaMcpTransportError);
    expect(enqueueSyncContinuation).not.toHaveBeenCalled();
    expect(checkpoint.value).toEqual({
      version: 1,
      nextDate: "2026-01-15",
      endDate: "2026-01-15",
      recordsSynced: 0,
    });
  });

  it("does not retain bearer state on the provider singleton across user syncs", async () => {
    const firstTokens = tokenSet("subject-a");
    const secondTokens = tokenSet("subject-b");
    const firstProtocol = successfulDateHarness();
    const secondProtocol = successfulDateHarness();
    const routed = routeFetch({
      mcpByBearer: new Map([
        [`Bearer ${firstTokens.accessToken}`, firstProtocol.fetch],
        [`Bearer ${secondTokens.accessToken}`, secondProtocol.fetch],
      ]),
    });
    mockLoadTokens.mockResolvedValueOnce(firstTokens).mockResolvedValueOnce(secondTokens);
    const provider = new ZivaProvider(routed.fetch);

    await provider.sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE, userId: "user-a" }),
    );
    await provider.sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE, userId: "user-b" }),
    );

    expect(firstProtocol.harness.bearerHeaders).toContain(`Bearer ${firstTokens.accessToken}`);
    expect(firstProtocol.harness.bearerHeaders).not.toContain(`Bearer ${secondTokens.accessToken}`);
    expect(secondProtocol.harness.bearerHeaders).toContain(`Bearer ${secondTokens.accessToken}`);
    expect(secondProtocol.harness.bearerHeaders).not.toContain(`Bearer ${firstTokens.accessToken}`);
    expect(firstProtocol.harness.jsonRpcMethods[0]).toBe("initialize");
    expect(secondProtocol.harness.jsonRpcMethods[0]).toBe("initialize");
  });
});
