import { eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "../db/schema/activity.ts";
import {
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
} from "../db/schema/climbing.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { THECRAG_PUBLIC_PROFILE_SCOPE } from "./thecrag/identity.ts";
import { TheCragProvider } from "./thecrag/provider.ts";
import { publicAscent, publicFeed } from "./thecrag/test-helpers.ts";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000003";
const feedEndpoint = "https://www.thecrag.com/feed/ascents/climber/:accountId";
const ascentEndpoint = "https://www.thecrag.com/ascent/:ascentId";
const server = setupServer();
type AscentFixture = Parameters<typeof publicAscent>[0];

describe("TheCragProvider.sync (PostgreSQL)", () => {
  let context: TestContext;
  const run = (options: { scheduled?: boolean; userId?: string } = {}) =>
    new TheCragProvider(globalThis.fetch).sync(
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
    context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "thecrag"))
      .orderBy(climbingLogEntry.id);
  const connect = async (userId = TEST_USER_ID, accountId = "123") => {
    await ensureProvider(context.db, "thecrag", "theCrag", "https://www.thecrag.com", userId);
    await saveTokens(
      context.db,
      "thecrag",
      {
        accessToken: "sampleclimber",
        providerAccountId: accountId,
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        scopes: THECRAG_PUBLIC_PROFILE_SCOPE,
      },
      userId,
    );
  };
  function serve(source: () => AscentFixture[]) {
    server.use(
      http.get(feedEndpoint, ({ params }) =>
        HttpResponse.text(
          publicFeed(
            source().map((ascent) => ({
              id: ascent?.id ?? "1001",
              routeId: ascent?.routeId ?? "2001",
              accountId: String(params.accountId),
            })),
            { accountId: String(params.accountId) },
          ),
          { headers: { "Content-Type": "application/atom+xml" } },
        ),
      ),
      http.get(ascentEndpoint, ({ params }) => {
        const ascent = source().find((item) => (item?.id ?? "1001") === params.ascentId);
        return ascent
          ? HttpResponse.html(publicAscent(ascent))
          : new HttpResponse(null, { status: 404 });
      }),
    );
  }
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

  it("upserts a public top-rope ascent with its count and only one described result", async () => {
    serve(() => [{}]);
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const original = await entries();
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await entries()).toEqual(original);
    expect(original).toEqual([
      expect.objectContaining({
        userId: TEST_USER_ID,
        externalId: "thecrag:1001",
        activityId: null,
        climbedOn: "2026-10-10",
        discipline: "rock_climbing",
        raw: expect.objectContaining({ accountId: "123" }),
      }),
    ]);
    expect(await context.db.select().from(climb).where(eq(climb.providerId, "thecrag"))).toEqual([
      expect.objectContaining({ externalId: "2001", kind: "route", name: "Sample route" }),
    ]);
    expect(await context.db.select().from(climbGrade)).toEqual([
      expect.objectContaining({ system: "yds", value: "5.10b" }),
    ]);
    const attempts = await context.db.select().from(climbingAttempt);
    expect(attempts).toHaveLength(4);
    expect(
      attempts.every(
        (attempt) => attempt.ropeMethod === "top_rope" && attempt.attemptIndex === null,
      ),
    ).toBe(true);
    expect(attempts.filter((attempt) => attempt.sourceResult !== null)).toHaveLength(1);
    expect(
      attempts
        .filter((attempt) => attempt.sourceResult === null)
        .every(
          (attempt) =>
            attempt.fellOrHung === null &&
            attempt.usedAid === null &&
            attempt.receivedBeta === null,
        ),
    ).toBe(true);
    expect(
      await context.db.select().from(activity).where(eq(activity.providerId, "thecrag")),
    ).toHaveLength(0);
  });
  it("stores four boulder attempts with only one described result and no rope method", async () => {
    serve(() => [
      {
        climbedStyle: "Boulder",
        routeStyle: "Boulder",
        routeGrade: "V4",
        tick: "Redpoint",
        attempts: "4",
      },
    ]);
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const attempts = await context.db.select().from(climbingAttempt);
    expect(attempts).toHaveLength(4);
    expect(attempts.filter((attempt) => attempt.sourceResult !== null)).toEqual([
      expect.objectContaining({ ropeMethod: null, fellOrHung: false, usedAid: false }),
    ]);
    expect(attempts.filter((attempt) => attempt.sourceResult === null)).toEqual([
      expect.objectContaining({ ropeMethod: null, fellOrHung: null, usedAid: null, dabbed: null }),
      expect.objectContaining({ ropeMethod: null, fellOrHung: null, usedAid: null, dabbed: null }),
      expect.objectContaining({ ropeMethod: null, fellOrHung: null, usedAid: null, dabbed: null }),
    ]);
  });

  it.each([
    ["Redpoint: Top rope", "completed", "top_rope", true],
    ["Onsight: Lead", "completed", "lead", true],
    ["Attempt: Top rope", "failed", "top_rope", null],
  ] as const)(
    "serves the observed outcome for %s without assigning outcomes to count placeholders",
    async (tick, outcome, ropeMethod, freeSend) => {
      serve(() => [{ tick, climbedStyle: ropeMethod === "lead" ? "Lead" : "Top rope" }]);
      expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
      const [entry] = await entries();
      if (!entry) throw new Error("Expected the imported ascent");
      expect(entry.raw).toMatchObject({ tick });
      const attempts = await executeWithSchema(
        context.db,
        z.object({
          source_result: z.string().nullable(),
          outcome: z.enum(["completed", "failed"]).nullable(),
          rope_method: z.string().nullable(),
        }),
        sql`SELECT source_result, outcome, rope_method FROM fitness.v_climbing_attempt
      WHERE climbing_log_entry_id = ${entry.id}::uuid`,
      );
      expect(attempts).toHaveLength(4);
      expect(attempts.filter((attempt) => attempt.source_result !== null)).toEqual([
        { source_result: tick.split(":")[0], outcome, rope_method: ropeMethod },
      ]);
      expect(attempts.filter((attempt) => attempt.source_result === null)).toEqual([
        { source_result: null, outcome: null, rope_method: ropeMethod },
        { source_result: null, outcome: null, rope_method: ropeMethod },
        { source_result: null, outcome: null, rope_method: ropeMethod },
      ]);
      const projected = await executeWithSchema(
        context.db,
        z.object({
          recorded_climb_outcome: z.enum(["completed", "failed"]).nullable(),
          free_send: z.boolean().nullable(),
        }),
        sql`SELECT recorded_climb_outcome, free_send FROM fitness.v_climbing_log_entry
      WHERE id = ${entry.id}::uuid`,
      );
      expect(projected).toEqual([
        {
          recorded_climb_outcome: outcome === "completed" ? "completed" : null,
          free_send: freeSend,
        },
      ]);
    },
  );
  it("rejects an unsupported route method before changing a prior import", async () => {
    let ascents: AscentFixture[] = [{}];
    serve(() => ascents);
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const previous = await entries();
    ascents = [
      { comment: "Updated public note" },
      { id: "1002", climbedStyle: "Sport", routeStyle: "Sport", tick: "Redpoint" },
    ];
    expect(await run({ scheduled: true })).toMatchObject({
      recordsSynced: 0,
      errors: [expect.any(Object)],
    });
    expect(await entries()).toEqual(previous);
  });
  it.each(["Top rope", "Boulder"])(
    "preserves stored data when a %s ascent exceeds the allocation budget",
    async (style) => {
      let ascents: AscentFixture[] = [{}];
      serve(() => ascents);
      expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
      const previous = await entries();
      const previousAttempts = await context.db
        .select()
        .from(climbingAttempt)
        .orderBy(climbingAttempt.id);
      ascents = [
        { comment: "This correction must not be saved" },
        {
          id: "1002",
          routeId: "2002",
          climbedStyle: style,
          routeStyle: style,
          routeGrade: style === "Boulder" ? "V4" : "5.10b",
          tick: style === "Boulder" ? "Attempt" : "Attempt: Top rope",
          attempts: "1001",
        },
      ];
      const result = await run();
      expect(result).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
      expect(result.errors[0]?.message).toContain("1002");
      expect(result.errors[0]?.message).toContain("1000");
      expect(await entries()).toEqual(previous);
      expect(await context.db.select().from(climbingAttempt).orderBy(climbingAttempt.id)).toEqual(
        previousAttempts,
      );
    },
  );
  it("updates a corrected day and preserves attachments, unseen entries and private notes", async () => {
    let ascents: AscentFixture[] = [{}, { id: "1002" }];
    serve(() => ascents);
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
      .set({ activityId: workout.id, notes: "Previously imported private note" })
      .where(eq(climbingLogEntry.externalId, "thecrag:1001"));
    const unseen = (await entries()).find((entry) => entry.externalId === "thecrag:1002");
    ascents = [{ date: "2020-01-20" }];
    expect(await run({ scheduled: true })).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "thecrag:1001",
          climbedOn: "2020-01-20",
          activityId: workout.id,
          notes: "Previously imported private note",
        }),
        unseen,
      ]),
    );
  });
  it("isolates source IDs and preserves both users' records on an empty feed", async () => {
    await connect(OTHER_USER_ID);
    let ascents: AscentFixture[] = [{}];
    serve(() => ascents);
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await run({ userId: OTHER_USER_ID })).toMatchObject({ recordsSynced: 1, errors: [] });
    const stored = await entries();
    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.userId).sort()).toEqual([TEST_USER_ID, OTHER_USER_ID]);
    ascents = [];
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await entries()).toEqual(stored);
  });
  it("clears a reported grade when the public ascent explicitly inherits its route grade again", async () => {
    let ascents: AscentFixture[] = [{ ascentGrade: "5.11a" }];
    serve(() => ascents);
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await context.db.select().from(climbingLogEntryGrade)).toEqual([
      expect.objectContaining({ system: "yds", value: "5.11a" }),
    ]);
    ascents = [{}];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await context.db.select().from(climbingLogEntryGrade)).toEqual([]);
    const sourceClimbId = (await entries())[0]?.climbId;
    if (!sourceClimbId) throw new Error("Expected the imported route");
    expect(
      await context.db.select().from(climbGrade).where(eq(climbGrade.climbId, sourceClimbId)),
    ).toEqual([expect.objectContaining({ system: "yds", value: "5.10b" })]);
  });
  it("preserves the previous account's records after connecting a new public identity", async () => {
    let ascents: AscentFixture[] = [{}];
    serve(() => ascents);
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    await connect(TEST_USER_ID, "999");
    ascents = [{ id: "1009" }];
    expect(await run({ scheduled: true })).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await entries()).toHaveLength(2);
    expect(await entries()).toEqual(
      expect.arrayContaining([
        previous[0],
        expect.objectContaining({ externalId: "thecrag:1009", providerAbsentAt: null }),
      ]),
    );
  });
  it("leaves stored data intact when a later feed page fails", async () => {
    serve(() => [{}]);
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    server.use(
      http.get(feedEndpoint, ({ request }) =>
        new URL(request.url).searchParams.has("paginateAt")
          ? new HttpResponse(null, { status: 400 })
          : HttpResponse.text(
              publicFeed([{}], {
                next: "https://www.thecrag.com/feed/ascents/climber/123?paginateAt=9000",
              }),
              { headers: { "Content-Type": "application/atom+xml" } },
            ),
      ),
    );
    expect(await run({ scheduled: true })).toMatchObject({
      recordsSynced: 0,
      errors: [expect.any(Object)],
    });
    expect(await entries()).toEqual(previous);
  });
  it("leaves stored data intact when a later ascent detail request fails", async () => {
    let ascents: AscentFixture[] = [{}];
    serve(() => ascents);
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    ascents = [{ comment: "A correction" }, { id: "1002" }];
    server.use(
      http.get(
        "https://www.thecrag.com/ascent/1002",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await entries()).toEqual(previous);
  });
  it("rolls back all ascent writes when a database constraint rejects one record", async () => {
    let ascents: AscentFixture[] = [{}];
    serve(() => ascents);
    expect(await run()).toMatchObject({ errors: [] });
    const previous = await entries();
    await context.db.execute(
      sql`ALTER TABLE fitness.climbing_log_entry ADD CONSTRAINT test_reject_ascent CHECK (external_id <> 'thecrag:1002')`,
    );
    try {
      ascents = [{ comment: "Updated note" }, { id: "1002" }];
      const result = await run();
      expect(result).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
      expect(result.errors[0]?.message).toMatch(/could not save/i);
      expect(await entries()).toEqual(previous);
    } finally {
      await context.db.execute(
        sql`ALTER TABLE fitness.climbing_log_entry DROP CONSTRAINT test_reject_ascent`,
      );
    }
  });
});
