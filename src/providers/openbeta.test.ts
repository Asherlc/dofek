import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ClimbingLogSyncInput } from "../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../db/index.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import {
  openBetaClimb as climb,
  openBetaGrades as grades,
  makeTransactionalTestDatabase,
  OPENBETA_TEST_USER_UUID as OPENBETA_USER_UUID,
  openBetaTick as tick,
} from "./test-helpers.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn().mockResolvedValue(undefined),
  loadTokens: vi.fn().mockResolvedValue({
    accessToken: "51e4a2f9-93ca-44db-9efb-9bc663da6cbe",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00Z"),
    scopes: "ticks",
  }),
  withSyncLog: vi.fn(async (_db, _provider, _type, callback) => (await callback()).result),
  persist: vi.fn(async (_db: SyncDatabase, input: ClimbingLogSyncInput) => ({
    logEntryIds: input.entries.map((entry) => entry.externalId),
    recordsSynced: input.entries.length,
  })),
  captureException: vi.fn(),
}));
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../db/sync-log.ts", () => ({ withSyncLog: mocks.withSyncLog }));
vi.mock("../db/climbing-log-sync.ts", () => ({ persistClimbingLogEntries: mocks.persist }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

import { OpenBetaProvider } from "./openbeta.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function graphqlResponse(data: unknown) {
  return jsonResponse({ data });
}
function makeDb() {
  return {
    db: makeTransactionalTestDatabase({
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    }),
  };
}
function makeRun(db: ReturnType<typeof makeDb>["db"], userId = USER_ID) {
  return new SyncRun({ db, userId, window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")) });
}
function makeRunWithoutUser(db: ReturnType<typeof makeDb>["db"]) {
  return new SyncRun({ db, window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")) });
}
function exchangeToken(provider: OpenBetaProvider, input: string) {
  const exchange = provider.authSetup().manualToken?.exchangeToken;
  if (!exchange) throw new Error("Missing public profile capability");
  return exchange(input);
}
function entries() {
  const input = mocks.persist.mock.calls[0]?.[1];
  if (!input) throw new Error("Expected source batch");
  return input.entries;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue({
    accessToken: OPENBETA_USER_UUID,
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00Z"),
    scopes: "ticks",
  });
});
describe("OpenBetaProvider", () => {
  it("resolves a public profile URL to the stable OpenBeta user UUID", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userPage: {
          profile: {
            userUuid: OPENBETA_USER_UUID,
            username: "climber",
            displayName: "Climber",
          },
        },
      }),
    );
    const provider = new OpenBetaProvider(fetchFn);
    const setup = provider.authSetup();

    const tokenSet = await setup.manualToken?.exchangeToken("https://openbeta.io/u/climber/ticks");

    expect(tokenSet).toMatchObject({
      accessToken: OPENBETA_USER_UUID,
      refreshToken: null,
      scopes: "ticks",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const request = z
      .object({ variables: z.object({ username: z.string() }) })
      .parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)));
    expect(request.variables).toEqual({ username: "climber" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openbeta.io",
      expect.objectContaining({
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      }),
    );
  });
  it.each([
    ["climber", "climber"],
    ["openbeta.io/u/climber", "climber"],
    ["http://www.openbeta.io/u/climber/ticks", "climber"],
  ])("accepts %s as the public profile identifier", async (input, expectedUsername) => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userPage: {
          profile: {
            userUuid: OPENBETA_USER_UUID,
            username: expectedUsername,
            displayName: null,
          },
        },
      }),
    );
    const provider = new OpenBetaProvider(fetchFn);

    await exchangeToken(provider, input);

    const request = z
      .object({ variables: z.object({ username: z.string() }) })
      .parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)));
    expect(request.variables).toEqual({ username: expectedUsername });
  });
  it("rejects malformed profile identifiers before making a request", async () => {
    const fetchFn = vi.fn();
    const provider = new OpenBetaProvider(fetchFn);
    for (const input of [
      "",
      "bad username",
      "https://example.com/u/climber",
      "https://openbeta.io/profile/climber",
      "https://openbeta.io/u/climber/other",
      "https://[",
    ]) {
      await expect(exchangeToken(provider, input)).rejects.toThrow(
        "Paste a public OpenBeta profile URL",
      );
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects a profile URL with an invalid percent-encoded username", async () => {
    const provider = new OpenBetaProvider(vi.fn());

    await expect(exchangeToken(provider, "https://openbeta.io/u/%E0%A4%A")).rejects.toMatchObject({
      message:
        "Paste a public OpenBeta profile URL or username, and make sure the profile is public.",
      authFailureReason: "authentication_failed",
      cause: expect.any(URIError),
    });
  });
  it.each([
    [() => new Response("", { status: 500 }), "OpenBeta API request failed (500)."],
    [
      () => jsonResponse({ data: null, errors: [{ message: "profile lookup denied" }] }),
      "OpenBeta API returned an error: profile lookup denied",
    ],
    [() => jsonResponse({ data: null }), "OpenBeta API returned no data."],
  ])("preserves profile lookup failure", async (makeResponse, causeMessage) => {
    const provider = new OpenBetaProvider(vi.fn().mockResolvedValue(makeResponse()));

    await expect(exchangeToken(provider, "climber")).rejects.toMatchObject({
      message: causeMessage,
    });
  });
  it("rejects a profile response that does not satisfy the profile schema", async () => {
    const provider = new OpenBetaProvider(
      vi
        .fn()
        .mockResolvedValue(
          graphqlResponse({ userPage: { profile: { username: "climber", displayName: null } } }),
        ),
    );

    await expect(exchangeToken(provider, "climber")).rejects.toMatchObject({
      name: "ZodError",
    });
  });
  it("preserves network failures for server error reporting", async () => {
    const error = new TypeError("fetch failed");
    const provider = new OpenBetaProvider(vi.fn().mockRejectedValue(error));

    await expect(exchangeToken(provider, "asherlc")).rejects.toBe(error);
  });
  it("explains when a public profile cannot be found", async () => {
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(graphqlResponse({ userPage: { profile: null } })),
    );

    await expect(exchangeToken(provider, "asherlc")).rejects.toMatchObject({
      message:
        "Paste a public OpenBeta profile URL or username, and make sure the profile is public.",
      authFailureReason: "authentication_failed",
    });
  });
  it.each([8640000000000001, 8640000000000000, -8640000000000000])(
    "does not reconcile a complete response when one tick has invalid date %s",
    async (timestamp) => {
      const fetchFn = vi.fn().mockResolvedValue(
        graphqlResponse({
          userTicks: [tick(), tick({ _id: "bad-date", dateClimbed: timestamp })],
        }),
      );
      const { db } = makeDb();
      const provider = new OpenBetaProvider(fetchFn);

      const result = await provider.sync(makeRun(db));

      expect(result.recordsSynced).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.degradations).toEqual([
        expect.objectContaining({
          kind: "record_rejected",
          providerId: "openbeta",
          stepName: "climbing_activity",
          context: { invalidDateCount: 1 },
        }),
      ]);
      expect(db.execute).not.toHaveBeenCalled();
    },
  );
  it("requires a user context before loading provider state", async () => {
    const { db } = makeDb();
    const provider = new OpenBetaProvider(vi.fn());

    const result = await provider.sync(makeRunWithoutUser(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "OpenBeta sync requires a user context." })],
    });
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.loadTokens).not.toHaveBeenCalled();
  });
  it("reports when the public profile identity is not stored", async () => {
    mocks.loadTokens.mockResolvedValueOnce(null);
    const { db } = makeDb();
    const provider = new OpenBetaProvider(vi.fn());

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringContaining("not found") })],
    });
  });
  it.each([502, 503, 504])("delegates HTTP %s tick failures to queue retries", async (status) => {
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(new Response("upstream timeout", { status })),
    );
    const { db } = makeDb();

    await expect(provider.sync(makeRun(db))).rejects.toBeInstanceOf(
      ProviderServiceUnavailableError,
    );

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("delegates request timeouts to queue retries", async () => {
    const error = new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 });
    const provider = new OpenBetaProvider(vi.fn().mockRejectedValue(error));
    const { db } = makeDb();

    await expect(provider.sync(makeRun(db))).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
      providerId: "openbeta",
      cause: error,
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
  it("captures tick export failures and returns their actionable message", async () => {
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );
    const { db } = makeDb();

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "OpenBeta API request failed (500)." })],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "OpenBeta API request failed (500)." }),
      { tags: { provider: "openbeta", phase: "tick_export" } },
    );
  });
  it("captures climbing-log write failures", async () => {
    mocks.withSyncLog.mockRejectedValueOnce(new Error("climbing entry write failed"));
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(graphqlResponse({ userTicks: [tick()] })),
    );
    const { db } = makeDb();

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "climbing entry write failed" })],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "climbing entry write failed" }),
      { tags: { provider: "openbeta", phase: "climbing_activity" } },
    );
  });
  it("does not retire existing ticks after an empty public tick list", async () => {
    const { db } = makeDb();
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(graphqlResponse({ userTicks: [] })),
    );

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "openbeta", recordsSynced: 0, errors: [] });
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("reports that OpenBeta is always configured and exposes manual profile auth", () => {
    const provider = new OpenBetaProvider(vi.fn());

    expect(provider.validate()).toBeNull();
    expect(provider.authSetup()).toMatchObject({
      apiBaseUrl: "https://api.openbeta.io",
      manualToken: {
        kind: "public-profile",
        label: "OpenBeta profile URL or username",
        instructionsUrl: "https://openbeta.io/",
      },
    });
  });
  it.each([
    [1786320000000, "2026-08-10"],
    [1786406399999, "2026-08-10"],
    [1786406400000, "2026-08-11"],
    [0, "1970-01-01"],
    [-1, "1969-12-31"],
    [null, null],
  ])("preserves numeric source date %s as %s", async (dateClimbed, date) => {
    const { db } = makeDb();
    expect(
      await new OpenBetaProvider(async () =>
        graphqlResponse({ userTicks: [tick({ dateClimbed })] }),
      ).sync(makeRun(db)),
    ).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(entries()[0]).toMatchObject({
      climbedOn: date,
      raw: expect.objectContaining({ dateClimbed }),
    });
  });
  it.each([
    ["Onsight", "free-onsight"],
    ["Flash", "free-flash"],
    ["Redpoint", "free-send"],
    ["Send", "free-send"],
    ["Fell/Hung", "fell-hung"],
  ])("maps qualifier %s without storing a result label", async (attemptType, qualifier) => {
    const { db } = makeDb();
    await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ attemptType })] }),
    ).sync(makeRun(db));
    expect(entries()[0]?.attempts[0]?.qualifier).toBe(qualifier);
  });
  it.each(["OB", "MP"])("uses the OpenBeta UUID namespace for source %s", async (source) => {
    const { db } = makeDb();
    await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ source }), tick({ source, _id: "tick-repeat" })] }),
    ).sync(makeRun(db));
    expect(entries().map((entry) => entry.externalId)).toEqual([
      "openbeta:tick-1",
      "openbeta:tick-repeat",
    ]);
    expect(entries().map((entry) => entry.climb?.externalId)).toEqual([
      "climb-uuid-1",
      "climb-uuid-1",
    ]);
  });
  it("stores coordinates on each located object with zero retained", async () => {
    const { db } = makeDb();
    const source = tick({
      climb: climb({
        metadata: { lat: 0, lng: -122.25 },
        pathTokens: ["Country", "Wall"],
        ancestors: ["area-country", "area-wall"],
        parent: { uuid: "area-wall", area_name: "Wall", metadata: { lat: 37.5, lng: 0 } },
      }),
    });
    await new OpenBetaProvider(async () => graphqlResponse({ userTicks: [source] })).sync(
      makeRun(db),
    );
    expect(entries()[0]?.climb).toMatchObject({
      coordinates: { latitude: 0, longitude: -122.25 },
      areas: [
        { externalId: "area-country", name: "Country" },
        { externalId: "area-wall", name: "Wall", coordinates: { latitude: 37.5, longitude: 0 } },
      ],
    });
  });
  it("rejects disagreeing climb references before writing", async () => {
    const { db } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ climbId: "different-id" })] }),
    ).sync(makeRun(db));
    expect(result.errors[0]?.message).toContain("climb identity");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("rejects a catalogue pitch whose parent differs from the containing climb", async () => {
    const { db } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({
        userTicks: [
          tick({
            climb: climb({
              pitches: [
                { id: "pitch-one", parentId: "other-climb", pitchNumber: 1, grades: grades() },
              ],
            }),
          }),
        ],
      }),
    ).sync(makeRun(db));
    expect(result.errors[0]?.message).toContain("pitch parent");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("preserves a pitch ID without inventing a positive number from zero", async () => {
    const { db } = makeDb();
    await new OpenBetaProvider(async () =>
      graphqlResponse({
        userTicks: [
          tick({
            climb: climb({
              pitches: [
                { id: "pitch-zero", parentId: "climb-uuid-1", pitchNumber: 0, grades: grades() },
              ],
            }),
          }),
        ],
      }),
    ).sync(makeRun(db));
    expect(entries()[0]?.climb?.pitches).toEqual([
      expect.objectContaining({
        externalId: "pitch-zero",
        publishedGrades: [{ value: "5.10a", system: "yds" }],
      }),
    ]);
    expect(entries()[0]?.raw).toMatchObject({
      climb: { pitches: [{ id: "pitch-zero", pitchNumber: 0 }] },
    });
  });
  it.each([
    { pathTokens: ["Crag", "Wall"], ancestors: ["area-1"] },
    {
      pathTokens: ["Wall"],
      ancestors: ["area-1"],
      parent: { uuid: "different", area_name: "Wall" },
    },
  ])("rejects mismatched hierarchy before writing %j", async (path) => {
    const { db } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ climb: climb(path) })] }),
    ).sync(makeRun(db));
    expect(result.errors[0]?.message).toContain("location path");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("keeps unclassified ungraded logs and unfamiliar source labels", async () => {
    const { db } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({
        userTicks: [
          tick({
            dateClimbed: null,
            grade: null,
            style: null,
            attemptType: "Frenchfree",
            climb: null,
          }),
        ],
      }),
    ).sync(makeRun(db));
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(entries()[0]).toMatchObject({
      climbedOn: null,
      notes: "Great movement",
      raw: expect.objectContaining({ attemptType: "Frenchfree" }),
      climb: { externalId: null },
    });
  });
  it.each([
    [{ sport: true, trad: false, bouldering: false }, ["sport"]],
    [{ sport: true, trad: true, bouldering: false }, ["sport", "trad"]],
    [{ sport: null, trad: null, bouldering: false }, null],
  ])("preserves protection %j independently of method", async (type, protection) => {
    const { db } = makeDb();
    await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ style: "TR", climb: climb({ type }) })] }),
    ).sync(makeRun(db));
    expect(entries()[0]).toMatchObject({
      climb: { routeProtection: protection },
      attempts: [{ scope: "climb", ropeMethod: "top_rope" }],
    });
  });
  it("retains all published scales and separately reported grade components", async () => {
    const { db } = makeDb();
    await new OpenBetaProvider(async () =>
      graphqlResponse({
        userTicks: [
          tick({
            grade: "5.9",
            climb: climb({
              grades: grades({ yds: "5.10a", french: "6a" }),
              pitches: [
                {
                  id: "pitch-one",
                  parentId: "climb-uuid-1",
                  pitchNumber: 1,
                  description: "Opening pitch",
                  grades: grades({ yds: "5.8" }),
                },
              ],
            }),
          }),
        ],
      }),
    ).sync(makeRun(db));
    expect(entries()[0]).toMatchObject({
      reportedGrades: [{ value: "5.9", system: "yds" }],
      climb: {
        publishedGrades: [
          { value: "5.10a", system: "yds" },
          { value: "6a", system: "french" },
        ],
        pitches: [
          {
            externalId: "pitch-one",
            number: 1,
            publishedGrades: [{ value: "5.8", system: "yds" }],
          },
        ],
      },
      attempts: [{ scope: "climb" }],
    });
  });
  it("keeps an unclassified separately reported grade outside the catalogue", async () => {
    const { db } = makeDb();
    await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ grade: "Source scale 4", climb: null })] }),
    ).sync(makeRun(db));
    expect(entries()[0]).toMatchObject({
      reportedGrades: [{ value: "Source scale 4", system: null }],
      climb: { externalId: null },
    });
  });
  it.each([253402300800000, -62167219200000, 8640000000000001])(
    "rejects malformed supplied date %s while retaining valid logs",
    async (dateClimbed) => {
      const { db } = makeDb();
      const result = await new OpenBetaProvider(async () =>
        graphqlResponse({ userTicks: [tick(), tick({ _id: "bad-date", dateClimbed })] }),
      ).sync(makeRun(db));
      expect(result).toMatchObject({
        recordsSynced: 1,
        errors: [
          expect.objectContaining({
            externalId: "bad-date",
            message: expect.stringContaining("invalid date"),
          }),
        ],
      });
    },
  );
});
