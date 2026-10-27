import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import type { Database, SyncDatabase } from "../../db/index.ts";
import { ProviderAuthorizationFailedError, RefreshTokenRevokedError } from "../auth-errors.ts";
import type { SyncCheckpointStore } from "../sync-run.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { ZivaMcpClient, ZivaMcpToolError, ZivaMcpTransportError } from "./client.ts";
import { ZivaProvider } from "./provider.ts";
import { createFakeZivaMcpHarness, type FakeZivaMcpHarness } from "./test-helpers.ts";

vi.mock("../../db/tokens.ts", () => ({
  deleteTokens: vi.fn(),
  deriveProviderAccountKey: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("./nutrition-writer.ts", () => ({
  upsertZivaMealsForDate: vi.fn(),
}));

vi.mock("../../lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));

const { deleteTokens, deriveProviderAccountKey, loadTokens, saveTokens } = await import(
  "../../db/tokens.ts"
);
const { captureException } = await import("../../lib/error-reporting.ts");
const { upsertZivaMealsForDate } = await import("./nutrition-writer.ts");

const mockDeleteTokens = vi.mocked(deleteTokens);
const mockDeriveProviderAccountKey = vi.mocked(deriveProviderAccountKey);
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
    origin?: "manual" | "scheduled";
    relativeWindow?: boolean;
    signal?: AbortSignal;
    requestedAt?: Date;
    window?: SyncWindow;
  } = {},
): SyncRun {
  return new SyncRun({
    db: options.db ?? fakeDatabase(),
    window:
      options.window ??
      SyncWindow.fromDateRange({
        sinceDate: options.sinceDate ?? FIRST_DATE,
        untilDate: options.untilDate ?? SECOND_DATE,
      }),
    origin: options.origin,
    relativeWindow: options.relativeWindow,
    signal: options.signal,
    requestedAt: options.requestedAt,
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

describe("ZivaProvider auth recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ZIVA_CLIENT_ID", "ziva-client-id");
    vi.stubEnv("ZIVA_CLIENT_SECRET", "ziva-client-secret");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
    mockLoadTokens.mockResolvedValue(tokenSet());
    mockSaveTokens.mockResolvedValue(undefined);
    mockDeleteTokens.mockResolvedValue(undefined);
    mockDeriveProviderAccountKey.mockImplementation(
      (_providerId, accountSubject, userId) => `${userId}:${accountSubject}`,
    );
    mockUpsertZivaMealsForDate.mockImplementation(async (_db, _userId, meals) => meals.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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

  it("does not refresh again when an expiry-refreshed bearer receives a 401", async () => {
    const expired = tokenSet("subject-a", {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const refreshedAccessToken = jwt("subject-a", { jti: "expiry-refresh" });
    const rejected = authenticationFailureHarness("tools/call");
    const routed = routeFetch({
      mcpByBearer: new Map([[`Bearer ${refreshedAccessToken}`, rejected.fetch]]),
      tokenResponse: () =>
        Response.json({
          access_token: refreshedAccessToken,
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
    });
    mockLoadTokens.mockResolvedValue(expired);

    const result = await new ZivaProvider(routed.fetch).sync(
      syncRun({ sinceDate: FIRST_DATE, untilDate: FIRST_DATE }),
    );

    expect(result).toMatchObject({ recordsSynced: 0, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(routed.tokenRequests).toHaveLength(1);
    expect(mockSaveTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteTokens).toHaveBeenCalledTimes(1);
    expect(rejected.transportClosed).toBe(true);
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
      sourceAccountKey: "user-a:subject-a",
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
      sourceAccountKey: "user-a:subject-a",
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
    expect(mockDeriveProviderAccountKey).toHaveBeenCalledWith("ziva", "subject-a", "user-a");
    expect(mockDeriveProviderAccountKey).toHaveBeenCalledWith("ziva", "subject-b", "user-b");
    const [firstWrite, secondWrite] = mockUpsertZivaMealsForDate.mock.calls;
    expect(firstWrite?.[2][0]?.sourceAccountKey).not.toBe(secondWrite?.[2][0]?.sourceAccountKey);
  });
});
