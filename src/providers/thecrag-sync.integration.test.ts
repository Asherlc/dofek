import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { persistClimbingLogEntries } from "../db/climbing-log-sync.ts";
import { userSettings } from "../db/schema/account.ts";
import { activity } from "../db/schema/activity.ts";
import { climb, climbingAttempt, climbingLogEntry } from "../db/schema/climbing.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { THECRAG_LOGBOOK_SCOPE } from "./thecrag/identity.ts";
import { TheCragProvider } from "./thecrag/provider.ts";
import { apiAscent, logbookPage } from "./thecrag/test-helpers.ts";

const server = createIntegrationMswFixture();
const endpoint = "https://www.thecrag.com/api/logbook/ascents";

describe("theCrag official logbook persistence (PostgreSQL)", () => {
  let context: TestContext;
  let requests: URL[];
  const run = (full = false) =>
    new TheCragProvider(globalThis.fetch).sync(
      new SyncRun({
        db: context.db,
        userId: TEST_USER_ID,
        window: full ? SyncWindow.full() : SyncWindow.lastDays(7),
        origin: full ? "manual" : "scheduled",
      }),
    );
  const entries = () =>
    context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.providerId, "thecrag"));
  const progress = async () => {
    const [row] = await context.db
      .select()
      .from(userSettings)
      .where(
        and(eq(userSettings.userId, TEST_USER_ID), eq(userSettings.key, "thecrag_sync_cursor")),
      );
    return row?.value;
  };
  const connect = async (accountId = "123", authorizationId = randomUUID()) => {
    await ensureProvider(
      context.db,
      "thecrag",
      "theCrag",
      "https://www.thecrag.com/api",
      TEST_USER_ID,
    );
    await saveTokens(
      context.db,
      "thecrag",
      {
        accessToken: "personal-key",
        providerAccountId: accountId,
        authorizationId,
        scopes: THECRAG_LOGBOOK_SCOPE,
        refreshToken: null,
        expiresAt: new Date("2099-12-31"),
      },
      TEST_USER_ID,
    );
  };
  function serve(reply: (url: URL) => Response = () => HttpResponse.json(logbookPage())) {
    server.use(
      http.get(endpoint, ({ request }) => {
        expect(request.headers.get("X-CData-Key")).toBe("key=personal-key");
        const url = new URL(request.url);
        requests.push(url);
        return reply(url);
      }),
    );
  }
  beforeAll(async () => {
    context = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
  }, 60000);
  beforeEach(async () => {
    requests = [];
    await context.db.execute(sql`TRUNCATE fitness.climb, fitness.area, fitness.activity CASCADE`);
    await context.db.delete(userSettings).where(eq(userSettings.key, "thecrag_sync_cursor"));
    await connect();
  });
  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.deactivate();
    await context?.cleanup();
  });

  it("imports an official ascent and reuses its canonical identity on replay", async () => {
    serve();
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const [original] = await entries();
    expect(original).toMatchObject({
      externalId: "thecrag:1001",
      notes: "Private training notes",
      climbedOn: "2026-10-10",
      activityId: null,
    });
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect((await entries())[0]?.id).toBe(original?.id);
    expect(requests[0]?.searchParams.has("since")).toBe(false);
    expect(requests[1]?.searchParams.get("since")).toBe("1791676799");
    expect(await progress()).toMatchObject({ accountId: "123", epoch: 1791676800 });
    expect(await context.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({ ropeMethod: "top_rope", sourceResult: "attempt" }),
    ]);
  });

  it("preserves an existing user-selected workout attachment and source ID", async () => {
    serve();
    await run();
    const [original] = await entries();
    const activityId = randomUUID();
    await context.db.insert(activity).values({
      id: activityId,
      userId: TEST_USER_ID,
      providerId: "thecrag",
      externalId: "existing-workout",
      canonicalType: "climbing",
      providerType: "climbing",
      startedAt: new Date("2026-10-10T12:00:00Z"),
    });
    await context.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET activity_id=${activityId}::uuid WHERE id=${original?.id}::uuid`,
    );
    server.resetHandlers();
    serve(() =>
      HttpResponse.json(
        logbookPage([apiAscent({ epoch: 1791676801, markdown: "Updated private note" })]),
      ),
    );
    expect(await run()).toMatchObject({ errors: [] });
    expect((await entries())[0]).toMatchObject({
      id: original?.id,
      activityId,
      notes: "Updated private note",
    });
  });

  it("preserves the recorded day when an incremental source response omits its date", async () => {
    serve();
    await run();
    server.resetHandlers();
    const source = apiAscent({ epoch: 1791676801 });
    Reflect.deleteProperty(source, "date");
    serve(() => HttpResponse.json(logbookPage([source])));
    expect(await run()).toMatchObject({ errors: [] });
    expect((await entries())[0]?.climbedOn).toBe("2026-10-10");
  });

  it("retains old imported entries when a successful delta is empty", async () => {
    serve();
    await run();
    const before = await entries();
    const cursor = await progress();
    server.resetHandlers();
    serve(() => HttpResponse.json(logbookPage([])));
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await entries()).toEqual(before);
    expect(await progress()).toEqual(cursor);
  });

  it("imports every page and saves the maximum source epoch", async () => {
    serve((url) => {
      const page = Number(url.searchParams.get("page"));
      return HttpResponse.json(
        logbookPage([apiAscent({ id: String(1000 + page), epoch: 300 - page })], {
          numberAscents: 2,
          perPage: 1,
          page: String(page),
        }),
      );
    });
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await entries()).toHaveLength(2);
    expect(await progress()).toMatchObject({ epoch: 299 });
  });

  it("imports full history again after reconnecting to the same account", async () => {
    serve();
    await run();
    await connect();
    await run();
    expect(requests.map((url) => url.searchParams.has("since"))).toEqual([false, false]);
  });

  it("keeps incremental state scoped to the connected remote account", async () => {
    serve();
    await run();
    await connect("456");
    server.resetHandlers();
    serve(() =>
      HttpResponse.json(logbookPage([apiAscent({ id: "1002" })], { account: { id: "456" } })),
    );
    expect(await run()).toMatchObject({ errors: [] });
    expect(requests[1]?.searchParams.has("since")).toBe(false);
    expect(await progress()).toMatchObject({ accountId: "456" });
    expect(await entries()).toHaveLength(2);
  });

  it("bypasses incremental progress for an explicit full import", async () => {
    serve();
    await run();
    await run(true);
    expect(requests[1]?.searchParams.has("since")).toBe(false);
  });

  it("applies a changed ascent at the same epoch without erasing a previously recorded rope method", async () => {
    serve();
    await run();
    server.resetHandlers();
    serve(() =>
      HttpResponse.json(
        logbookPage([
          apiAscent({
            climbedGearStyle: "sport",
            tick: { label: "redpoint" },
            markdown: "Same second edit",
            route: { id: "2001", style: "Sport" },
          }),
        ]),
      ),
    );
    expect(await run()).toMatchObject({ errors: [] });
    expect((await entries())[0]?.notes).toBe("Same second edit");
    expect(await context.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({ ropeMethod: "top_rope", sourceResult: "redpoint" }),
    ]);
  });

  it.each(["http", "incomplete", "malformed", "duplicate", "wrong account"])(
    "preserves saved data and progress after a %s page failure",
    async (failure) => {
      serve();
      await run();
      const before = await entries();
      const cursor = await progress();
      server.resetHandlers();
      serve((url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1)
          return HttpResponse.json(
            logbookPage([apiAscent({ epoch: 1791676900 })], { numberAscents: 2, perPage: 1 }),
          );
        if (failure === "http") return new HttpResponse(null, { status: 500 });
        if (failure === "malformed")
          return HttpResponse.json({ data: { malformed: "not a page" } });
        if (failure === "incomplete")
          return HttpResponse.json(logbookPage([], { numberAscents: 2, perPage: 1, page: "2" }));
        return HttpResponse.json(
          logbookPage([apiAscent({ id: failure === "duplicate" ? "1001" : "1002" })], {
            numberAscents: 2,
            perPage: 1,
            page: "2",
            account: { id: failure === "wrong account" ? "456" : "123" },
          }),
        );
      });
      expect((await run()).errors).toHaveLength(1);
      expect(await entries()).toEqual(before);
      expect(await progress()).toEqual(cursor);
    },
  );

  it("rolls back source writes and keeps progress when Postgres rejects a write", async () => {
    serve();
    await run();
    const before = await entries();
    const cursor = await progress();
    await context.db.execute(
      sql`CREATE FUNCTION fitness.reject_thecrag_test_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE check_violation USING MESSAGE='private-bound-note'; END; $$`,
    );
    await context.db.execute(
      sql`CREATE TRIGGER reject_thecrag_test_write BEFORE INSERT OR UPDATE ON fitness.climbing_log_entry FOR EACH ROW EXECUTE FUNCTION fitness.reject_thecrag_test_write()`,
    );
    server.resetHandlers();
    serve(() =>
      HttpResponse.json(
        logbookPage([apiAscent({ epoch: 1791676900, markdown: "must not persist" })]),
      ),
    );
    const result = await run();
    await context.db.execute(
      sql`DROP TRIGGER reject_thecrag_test_write ON fitness.climbing_log_entry`,
    );
    await context.db.execute(sql`DROP FUNCTION fitness.reject_thecrag_test_write()`);
    expect(result.errors[0]?.message).toMatch(/could not save/);
    expect(JSON.stringify(result)).not.toContain("private-bound-note");
    expect(await entries()).toEqual(before);
    expect(await progress()).toEqual(cursor);
  });

  it("does not confuse historical public credentials with official API keys", async () => {
    await saveTokens(
      context.db,
      "thecrag",
      {
        accessToken: "sampleclimber",
        providerAccountId: "123",
        scopes: "thecrag:public-profile",
        refreshToken: null,
        expiresAt: new Date("2099-12-31"),
      },
      TEST_USER_ID,
    );
    serve();
    expect((await run()).errors[0]?.message).toMatch(/Reconnect/);
    expect(requests).toHaveLength(0);
  });

  it("keeps recorded attempts from earlier public imports when the API omits totals", async () => {
    await persistClimbingLogEntries(context.db, {
      userId: TEST_USER_ID,
      providerId: "thecrag",
      entries: [
        {
          externalId: "thecrag:1001",
          climbedOn: "2026-10-10",
          climb: { externalId: "2001", kind: "route" },
          reportedAttemptCounts: [{ scope: "climb", count: 4 }],
          attempts: [
            { scope: "climb", sourceResult: "attempt", ropeMethod: "top_rope" },
            { scope: "climb", ropeMethod: "top_rope" },
            { scope: "climb", ropeMethod: "top_rope" },
            { scope: "climb", ropeMethod: "top_rope" },
          ],
        },
      ],
    });
    const [original] = await entries();
    serve();
    expect(await run()).toMatchObject({ errors: [] });
    expect((await entries())[0]?.id).toBe(original?.id);
    expect(await context.db.select().from(climbingAttempt)).toHaveLength(4);
  });

  it("does not create synthetic activities while retaining route facts", async () => {
    serve();
    await run();
    expect(await context.db.select().from(activity)).toHaveLength(0);
    expect(await context.db.select().from(climb)).toEqual([
      expect.objectContaining({ externalId: "2001", name: "Sample route", kind: "route" }),
    ]);
  });
});
