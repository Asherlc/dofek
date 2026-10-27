import { ProviderRequestTimeoutError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { createMockDatabase } from "../test-helpers.ts";
import { TheCragProvider } from "./provider.ts";
import { lookupResponse, makeRun, publicAscent, publicFeed, tokens } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  write: vi.fn(async (_db, _user, _provider, records: SourceClimbingLogEntry[]) => records.length),
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  captureException: vi.fn(),
  withSyncLog: vi.fn(async (_db, _id, _type, callback) => (await callback()).result),
}));
vi.mock("./persistence.ts", () => ({ writeClimbingRecords: mocks.write }));
vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../../db/sync-log.ts", () => ({ withSyncLog: mocks.withSyncLog }));
vi.mock("../../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));
afterEach(() => {
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue(tokens());
});
mocks.loadTokens.mockResolvedValue(tokens());

function publicRequests(feed = publicFeed(), ascent = publicAscent()) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/lookup/climber") return lookupResponse();
    return new Response(url.pathname.includes("/feed/") ? feed : ascent);
  });
}

describe("theCrag public profile", () => {
  it.each([
    " sampleclimber ",
    "https://www.thecrag.com/climber/sampleclimber",
    "https://www.thecrag.com/en/climber/sampleclimber",
    "https://www.thecrag.com/ascents/by/sampleclimber",
    "https://www.thecrag.com/en/ascents/by/sampleclimber",
  ])("resolves public identity %s", async (input) => {
    const fetchFn = publicRequests();
    const auth = new TheCragProvider(fetchFn).authSetup();
    expect(auth.manualToken?.kind).toBe("public-profile");
    await expect(auth.manualToken?.exchangeToken(input)).resolves.toMatchObject({
      accessToken: "sampleclimber",
      providerAccountId: "123",
      scopes: "thecrag:public-profile",
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://www.thecrag.com/api/lookup/climber?search=sampleclimber",
    );
  });
  it.each([
    "",
    "https://evil.example/climber/sampleclimber",
    "https://www.thecrag.com/login",
    "name/key",
    "name\nkey",
  ])("rejects invalid public identity %j before network", async (input) => {
    const fetchFn = publicRequests();
    await expect(
      new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken(input),
    ).rejects.toThrow(/username|profile/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    { data: [{ id: "123", login: "other" }] },
    { data: [{ id: "bad", login: "sampleclimber" }] },
    { data: [] },
  ])("requires exact lookup identity %j", async (data) => {
    await expect(
      new TheCragProvider(async () => Response.json(data))
        .authSetup()
        .manualToken?.exchangeToken("sampleclimber"),
    ).rejects.toThrow(/profile|account/i);
  });
  it.each(["logbook:read", null, "thecrag:public-profile logbook:read"])(
    "rejects legacy scope %j without requesting its secret",
    async (scopes) => {
      mocks.loadTokens.mockResolvedValue({ ...tokens(), accessToken: "private-secret", scopes });
      const fetchFn = publicRequests();
      const result = await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
      expect(result.errors[0]?.message).toMatch(/reconnect/i);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it("maps recorded climb date, top rope and reported count without manufacturing result facts", async () => {
    const result = await new TheCragProvider(publicRequests()).sync(
      makeRun(createMockDatabase().db),
    );
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    const record = mocks.write.mock.calls[0]?.[3][0];
    expect(record).toMatchObject({
      externalId: "thecrag:1001",
      climbedOn: "2026-10-10",
      reportedAttemptCounts: [{ scope: "climb", count: 4 }],
      climb: {
        externalId: "2001",
        name: "Sample route",
        kind: "route",
        publishedGrades: [{ system: "yds", value: "5.10b" }],
      },
      attempts: expect.arrayContaining([
        expect.objectContaining({ scope: "climb", ropeMethod: "top_rope" }),
      ]),
    });
    expect(record?.attempts).toHaveLength(4);
    expect(record?.attempts.slice(1)).toEqual(
      Array.from({ length: 3 }, () => ({ scope: "climb", ropeMethod: "top_rope" })),
    );
    expect(record).not.toHaveProperty("notes");
    expect(record?.reportedGrades).toEqual([]);
  });
  it("preserves published/reported grades, public note text and source fields", async () => {
    await new TheCragProvider(
      publicRequests(
        publicFeed(),
        publicAscent({ ascentGrade: "5.10c", comment: "<p>Public &amp; note</p>" }),
      ),
    ).sync(makeRun(createMockDatabase().db));
    expect(mocks.write.mock.calls[0]?.[3][0]).toMatchObject({
      notes: "Public & note",
      reportedGrades: [{ value: "5.10c", system: "yds" }],
      raw: { accountId: "123" },
    });
  });
  it("follows Atom next including a terminal empty page and deduplicates repeated events", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          publicFeed([{}, {}], {
            next: "https://www.thecrag.com/feed/ascents/climber/123?paginateAt=9000",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(publicFeed([])))
      .mockImplementationOnce(async () => {
        expect(mocks.write).not.toHaveBeenCalled();
        return new Response(publicAscent());
      });
    expect(await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db))).toMatchObject(
      { recordsSynced: 1, errors: [] },
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it.each([
    publicFeed([{ accountId: "456" }]),
    "<html>Cloudflare blocked</html>",
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry></feed>',
    publicFeed([{}], { next: "https://evil.example/feed/ascents/climber/123" }),
    publicFeed([{}], { next: "https://www.thecrag.com/feed/ascents/climber/456?paginateAt=1" }),
    publicFeed([{}], { next: "https://www.thecrag.com/feed/ascents/climber/123" }),
  ])("rejects invalid feed before persistence", async (feed) => {
    const result = await new TheCragProvider(publicRequests(feed)).sync(
      makeRun(createMockDatabase().db),
    );
    expect(result.errors).toHaveLength(1);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([
    { username: "other" },
    { routeId: "999" },
    { id: "999" },
    { date: "2026-02-30" },
    { date: "2026" },
    { tick: "Attempt", climbedStyle: "", routeStyle: "" },
  ])("rejects invalid detail %j before persistence", async (detail) => {
    const result = await new TheCragProvider(
      publicRequests(publicFeed(), publicAscent(detail)),
    ).sync(makeRun(createMockDatabase().db));
    expect(result.errors).toHaveLength(1);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("preserves all stored records when a later detail fails", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(publicFeed([{}, { id: "1002" }])))
      .mockResolvedValueOnce(new Response(publicAscent()))
      .mockResolvedValueOnce(new Response("Denied", { status: 403 }));
    const result = await new TheCragProvider(fetchFn).sync(makeRun(createMockDatabase().db));
    expect(result.errors[0]?.message).toMatch(/403/);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects redirects to a nonpublic resource", async () => {
    const body = new Response(publicFeed());
    Object.defineProperty(body, "url", { value: "https://www.thecrag.com/login" });
    const result = await new TheCragProvider(async () => body).sync(
      makeRun(createMockDatabase().db),
    );
    expect(result.errors[0]?.message).toMatch(/redirect|public/i);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("preserves transport errors for queue retry", async () => {
    const error = new ProviderRequestTimeoutError({ providerId: "thecrag", timeoutMs: 120_000 });
    await expect(
      new TheCragProvider(async () => {
        throw error;
      }).sync(makeRun(createMockDatabase().db)),
    ).rejects.toMatchObject({ name: "ProviderRequestTimeoutError", providerId: "thecrag" });
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
