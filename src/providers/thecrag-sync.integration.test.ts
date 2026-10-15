import { eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity } from "../db/schema/activity.ts";
import { climb, climbGrade, climbingAttempt, climbingLogEntry } from "../db/schema/climbing.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { theCragAscent, theCragPage } from "./test-helpers.ts";
import { TheCragProvider } from "./thecrag.ts";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000003";
const endpoint = "https://www.thecrag.com/api/logbook/ascents";
const server = setupServer();

describe("TheCragProvider.sync (PostgreSQL)", () => {
  let context: TestContext;

  const run = (options: { scheduled?: boolean; userId?: string } = {}) =>
    new TheCragProvider().sync(
      new SyncRun({
        db: context.db,
        window: options.scheduled
          ? SyncWindow.lastDays(7, { now: new Date("2026-10-11T12:00:00Z") })
          : SyncWindow.full(new Date("2026-10-11T12:00:00Z")),
        userId: options.userId ?? TEST_USER_ID,
        origin: options.scheduled ? "scheduled" : "manual",
      }),
    );

  const entries = () =>
    context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.providerId, "thecrag"));

  const connect = async (userId = TEST_USER_ID, accountId = "123") => {
    await ensureProvider(context.db, "thecrag", "theCrag", "https://www.thecrag.com/api", userId);
    await saveTokens(
      context.db,
      "thecrag",
      {
        accessToken: `test-key-${accountId}`,
        providerAccountId: accountId,
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        scopes: "logbook:read",
      },
      userId,
    );
  };

  beforeAll(async () => {
    context = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${OTHER_USER_ID}::uuid, 'Other climber')`);
  }, 60_000);

  beforeEach(async () => {
    await connect();
    await context.db.delete(climbingLogEntry).where(eq(climbingLogEntry.providerId, "thecrag"));
    await context.db.delete(activity).where(eq(activity.providerId, "thecrag"));
  });

  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.close();
    if (context) await context.cleanup();
  });

  it("upserts an ascent without creating a workout or losing its source payload", async () => {
    const ascent = theCragAscent();
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([ascent]))));
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await entries()).toEqual([
      expect.objectContaining({
        userId: TEST_USER_ID,
        externalId: "thecrag:1001",
        activityId: null,
        climbedOn: "2026-10-10",
        discipline: "rock_climbing",
        raw: { accountId: "123", ascent },
      }),
    ]);
    expect(await context.db.select().from(climb).where(eq(climb.providerId, "thecrag"))).toEqual([
      expect.objectContaining({
        externalId: "2001",
        kind: "route",
        name: "Sunset Arete",
        routeProtection: ["sport"],
      }),
    ]);
    expect(await context.db.select().from(climbGrade)).toEqual([
      expect.objectContaining({ system: "yds", value: "5.10a" }),
    ]);
    expect(await context.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({
        scope: "climb",
        sourceResult: "redpoint",
        fellOrHung: false,
        usedAid: false,
        protectionUsed: ["sport"],
        receivedBeta: null,
        attemptIndex: null,
      }),
    ]);
    expect(
      await context.db.select().from(activity).where(eq(activity.providerId, "thecrag")),
    ).toHaveLength(0);
  });

  it("updates a corrected climb day while preserving a user-selected activity attachment", async () => {
    let ascents = [theCragAscent(), theCragAscent({ id: "1002" })];
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage(ascents))));
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const [workout] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId: "thecrag",
        externalId: "recorded-workout",
        providerType: "climbing",
        canonicalType: "climbing",
        startedAt: new Date("2026-10-10T12:00:00Z"),
      })
      .returning();
    if (!workout) throw new Error("Fixture activity was not inserted");
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: workout.id })
      .where(eq(climbingLogEntry.externalId, "thecrag:1002"));
    ascents = [
      theCragAscent({ date: "2026-10-09", epoch: 1791676810 }),
      theCragAscent({ id: "1002", date: "2026-10-09", epoch: 1791676810 }),
    ];
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "thecrag:1001", climbedOn: "2026-10-09" }),
        expect.objectContaining({
          externalId: "thecrag:1002",
          activityId: workout.id,
          climbedOn: "2026-10-09",
          raw: { accountId: "123", ascent: ascents[1] },
        }),
      ]),
    );
  });

  it("derives incremental update time from the account's raw ascents and imports backdated edits", async () => {
    const requestedSince: Array<string | null> = [];
    let ascents = [theCragAscent()];
    server.use(
      http.get(endpoint, ({ request }) => {
        requestedSince.push(new URL(request.url).searchParams.get("since"));
        return HttpResponse.json(theCragPage(ascents));
      }),
    );
    expect(await run({ scheduled: true })).toMatchObject({ recordsSynced: 1, errors: [] });
    ascents = [theCragAscent({ date: "2020-01-20", epoch: 1791676810 })];
    expect(await run({ scheduled: true })).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(requestedSince).toEqual([null, "1791676799"]);
    expect(await entries()).toEqual([
      expect.objectContaining({
        climbedOn: "2020-01-20",
        raw: { accountId: "123", ascent: ascents[0] },
      }),
    ]);
    expect(await run()).toMatchObject({ errors: [] });
    expect(requestedSince.at(-1)).toBeNull();
  });

  it("keeps identical source IDs isolated between Dofek users", async () => {
    await connect(OTHER_USER_ID);
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([theCragAscent()]))));
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await run({ userId: OTHER_USER_ID })).toMatchObject({ recordsSynced: 1, errors: [] });
    const stored = await entries();
    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.userId).sort()).toEqual([TEST_USER_ID, OTHER_USER_ID]);
  });

  it("starts without a watermark after connecting a different external account", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([theCragAscent()]))));
    expect(await run({ scheduled: true })).toMatchObject({ errors: [] });
    await connect(TEST_USER_ID, "999");
    let requestedSince: string | null | undefined;
    server.use(
      http.get(endpoint, ({ request }) => {
        requestedSince = new URL(request.url).searchParams.get("since");
        return HttpResponse.json(
          theCragPage([theCragAscent({ id: "1009", epoch: 100 })], {
            account: { id: "999", name: "Other account", login: "other" },
          }),
        );
      }),
    );
    expect(await run({ scheduled: true })).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(requestedSince).toBeNull();
    expect(await entries()).toHaveLength(2);
  });

  it("leaves stored data intact when a later API page fails", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([theCragAscent()]))));
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    server.use(
      http.get(endpoint, ({ request }) =>
        new URL(request.url).searchParams.get("page") === "1"
          ? HttpResponse.json(
              theCragPage([theCragAscent({ epoch: 1791676999 })], { perPage: 1, numberAscents: 2 }),
            )
          : new HttpResponse(null, { status: 400 }),
      ),
    );
    expect(await run({ scheduled: true })).toMatchObject({
      recordsSynced: 0,
      errors: [expect.any(Object)],
    });
    expect(await entries()).toEqual(previous);
  });

  it("rolls back all ascent writes when a PostgreSQL constraint rejects one record", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([theCragAscent()]))));
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    await context.db.execute(sql`ALTER TABLE fitness.climbing_log_entry ADD CONSTRAINT test_reject_ascent
      CHECK (external_id <> 'thecrag:1002')`);
    try {
      server.use(
        http.get(endpoint, () =>
          HttpResponse.json(
            theCragPage([
              theCragAscent({ epoch: 1791676999 }),
              theCragAscent({ id: "1002", epoch: 1791676998 }),
            ]),
          ),
        ),
      );
      const result = await run();
      expect(result).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
      expect(result.errors[0]?.message).not.toContain("Personal ascent notes");
      expect(await entries()).toEqual(previous);
    } finally {
      await context.db.execute(
        sql`ALTER TABLE fitness.climbing_log_entry DROP CONSTRAINT test_reject_ascent`,
      );
    }
  });

  it("keeps ascents when an update response is empty", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([theCragAscent()]))));
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    server.use(http.get(endpoint, () => HttpResponse.json(theCragPage([]))));
    expect(await run({ scheduled: true })).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await entries()).toEqual(previous);
  });

  it("rejects an account response belonging to another key owner before writing", async () => {
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json(
          theCragPage([theCragAscent()], {
            account: { id: "456", name: "Wrong account", login: "wrong" },
          }),
        ),
      ),
    );
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await entries()).toHaveLength(0);
  });
});
