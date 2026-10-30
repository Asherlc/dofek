import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { ProviderRequestTimeoutError } from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDatabase } from "../test-helpers.ts";
import { TheCragProvider } from "./provider.ts";
import { apiAscent, logbookPage, makeRun } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  write: vi.fn(async (_db, _user, _provider, records) => records.length),
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  captureException: vi.fn(),
  loadProgress: vi.fn(),
  saveProgress: vi.fn(),
  withSyncLog: vi.fn(async (_db, _id, _type, callback) => (await callback()).result),
}));
vi.mock("./persistence.ts", () => ({ writeClimbingRecords: mocks.write }));
vi.mock("./progress.ts", () => ({
  TheCragSyncProgress: class {
    load = mocks.loadProgress;
    save = mocks.saveProgress;
  },
}));
vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../../db/sync-log.ts", () => ({ withSyncLog: mocks.withSyncLog }));
vi.mock("../../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));
const authorizationId = randomUUID();
const keyTokens = () => ({
  accessToken: "personal-key",
  providerAccountId: "123",
  authorizationId,
  scopes: "thecrag:logbook-read",
  refreshToken: null,
  expiresAt: new Date("2099-12-31"),
});
beforeEach(() => {
  mocks.loadTokens.mockResolvedValue(keyTokens());
  mocks.loadProgress.mockResolvedValue(undefined);
  mocks.saveProgress.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const fetchPage = () =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(logbookPage()));

describe("theCrag official API provider", () => {
  it("advertises and validates a per-user supporter API key", async () => {
    const fetchFn = fetchPage();
    const provider = new TheCragProvider(fetchFn);
    expect(provider.validate()).toBeNull();
    expect(provider.authSetup().manualToken).toMatchObject({
      kind: "access-token",
      label: "Personal API key",
      instructionsUrl: "https://www.thecrag.com/en/article/logbookreadapi",
    });
    const tokens = await provider.authSetup().manualToken?.exchangeToken(" personal-key ");
    expect(tokens).toMatchObject({
      accessToken: "personal-key",
      providerAccountId: "123",
      scopes: "thecrag:logbook-read",
      authorizationId: expect.any(String),
    });
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("X-CData-Key")).toBe(
      "key=personal-key",
    );
    const replacement = await provider.authSetup().manualToken?.exchangeToken("personal-key");
    expect(replacement?.authorizationId).not.toBe(tokens?.authorizationId);
  });
  it.each([
    null,
    { ...keyTokens(), scopes: "thecrag:public-profile" },
    { ...keyTokens(), authorizationId: undefined },
    { ...keyTokens(), providerAccountId: undefined },
  ])("requires reconnection before requests for incomplete credentials", async (tokens) => {
    mocks.loadTokens.mockResolvedValue(tokens);
    const fetchFn = fetchPage();
    const result = await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
    expect(result.errors[0]?.message).toMatch(/reconnect/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("imports complete paginated history before advancing progress", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return Response.json(
        logbookPage([apiAscent({ id: String(1000 + page), epoch: 100 + page })], {
          numberAscents: 2,
          perPage: 1,
          page: String(page),
        }),
      );
    });
    const result = await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
    expect(result).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(
      mocks.write.mock.calls[0]?.[3].map((entry: { externalId: string }) => entry.externalId),
    ).toEqual(["thecrag:1001", "thecrag:1002"]);
    expect(mocks.saveProgress).toHaveBeenCalledWith(102);
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveProgress.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("replays the last source second for incremental updates outside the requested date window", async () => {
    mocks.loadProgress.mockResolvedValue(1791676800);
    const fetchFn = fetchPage();
    expect(
      await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db, { full: false })),
    ).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.get("since")).toBe(
      "1791676799",
    );
  });
  it("bypasses a saved cursor on an explicit full import", async () => {
    mocks.loadProgress.mockResolvedValue(1791676800);
    const fetchFn = fetchPage();
    await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.has("since")).toBe(false);
  });
  it("preserves the cursor and stored records for an empty delta", async () => {
    mocks.loadProgress.mockResolvedValue(1791676800);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(logbookPage([])));
    expect(
      await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db, { full: false })),
    ).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });
  it.each([
    logbookPage([], { numberAscents: 2, perPage: 1 }),
    logbookPage([apiAscent()], { page: 2 }),
    logbookPage([apiAscent()], { account: { id: "456" } }),
    logbookPage([apiAscent(), apiAscent()]),
  ])("rejects incomplete, mismatched and duplicate pages without saving", async (body) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    const result = await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
    expect(result.errors).toHaveLength(1);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });
  it("does not save or advance after a failed later page", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(logbookPage([apiAscent()], { numberAscents: 2, perPage: 1 })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(
      (await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db))).errors,
    ).toHaveLength(1);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });
  it("does not advance after a persistence failure", async () => {
    mocks.write.mockRejectedValueOnce(new Error("theCrag could not save your logbook."));
    expect(
      (await new TheCragProvider(fetchPage()).sync(makeRun(createMockDatabase().db))).errors,
    ).toHaveLength(1);
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });
  it("keeps source credentials and notes out of schema-error telemetry", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(logbookPage([apiAscent({ date: "personal-key Private training notes" })])),
      );
    const result = await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
    expect(result.errors).toHaveLength(1);
    expect(
      inspect({ result, calls: mocks.captureException.mock.calls }, { depth: null }),
    ).not.toMatch(/personal-key|Private training notes/);
  });
  it("preserves retryable request timeout classification", async () => {
    const timeout = new ProviderRequestTimeoutError({ providerId: "thecrag", timeoutMs: 120000 });
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    await expect(
      new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db)),
    ).rejects.toMatchObject({ code: "ETIMEDOUT", providerId: "thecrag" });
  });
});

it.each([429, 502, 503, 504])(
  "sanitizes HTTP %s through the complete transport wrapper and token exchange",
  async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("personal-key private-upstream-notes", {
          status,
          headers: { "Retry-After": "17" },
        }),
    );
    const provider = new TheCragProvider(fetchFn);
    const output = await provider.sync(makeRun(createMockDatabase().db)).then(
      (result) => result,
      (error: Error) => error,
    );
    const syncFailure = output instanceof Error ? output : output.errors[0]?.cause;
    expect(syncFailure).toMatchObject({
      providerId: "thecrag",
      statusCode: status,
      retryAfterSeconds: 17,
    });
    const connectFailure = await provider
      .authSetup()
      .manualToken?.exchangeToken("personal-key")
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(connectFailure).toMatchObject({
      providerId: "thecrag",
      statusCode: status,
      retryAfterSeconds: 17,
    });
    expect(
      inspect(
        { syncFailure, connectFailure, calls: mocks.captureException.mock.calls },
        { depth: null },
      ),
    ).not.toMatch(/personal-key|private-upstream-notes/);
  },
);
