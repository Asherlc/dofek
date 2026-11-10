import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { persistClimbingLogEntries } from "./climbing-log-sync.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

describe("derived climbing log source sessions", () => {
  let context: TestContext;
  let userId: string;
  const providerId = "kilter";
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES (${providerId}, 'Kilter Board') ON CONFLICT (id) DO NOTHING`);
  });
  beforeEach(async () => {
    userId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Source session test')`);
  });
  afterAll(async () => {
    await context.cleanup();
  });

  async function write(
    observations: readonly {
      time: string;
      board?: string | null;
      gym?: string | null;
      externalId?: string;
    }[],
    ownerId = userId,
  ) {
    return persistClimbingLogEntries(context.db, {
      userId: ownerId,
      providerId,
      entries: observations.map((observation, index) => ({
        externalId: observation.externalId ?? `log:${index}`,
        board: observation.board ? { name: "Board", externalId: observation.board } : null,
        activityObservation: {
          recordedAt: observation.time,
          gymExternalId: observation.gym ?? null,
        },
        attempts: [],
      })),
    });
  }
  const sessions = () =>
    executeWithSchema(
      context.db,
      z.object({
        user_id: z.guid(),
        provider_id: z.string(),
        activity_id: z.guid(),
        log_entry_id: z.guid(),
        recorded_at: z.coerce.date(),
        session_id: z.guid(),
        first_logged_at: z.coerce.date(),
        last_logged_at: z.coerce.date(),
      }),
      sql`SELECT observation.* FROM fitness.v_climbing_log_activity AS observation
    JOIN fitness.activity AS point ON point.id = observation.activity_id
    WHERE observation.user_id = ${userId}::uuid ORDER BY observation.recorded_at, point.external_id`,
    );

  it.each([
    { label: "incident logs 4m33s apart", times: ["01:48:51.544", "01:53:24.245"], groups: [0, 0] },
    { label: "an exact ten-minute gap", times: ["01:00:00", "01:10:00"], groups: [0, 1] },
    { label: "a gap just below ten minutes", times: ["01:00:00", "01:09:59.999"], groups: [0, 0] },
    {
      label: "successive gaps spanning more than ten minutes",
      times: ["01:00:00", "01:09:00", "01:18:00", "01:27:00"],
      groups: [0, 0, 0, 0],
    },
    { label: "a singleton", times: ["01:00:00"], groups: [0] },
  ])("derives $label from actual observation bounds", async ({ times, groups }) => {
    await write(times.map((time) => ({ time: `2026-11-10T${time}Z` })));
    const rows = await sessions();
    expect(rows).toHaveLength(times.length);
    for (const [index, row] of rows.entries()) {
      const anchor = rows[groups[index] ?? 0];
      expect(row.session_id).toBe(anchor?.activity_id);
      const sameSession = rows.filter((_, candidate) => groups[candidate] === groups[index]);
      expect(row.first_logged_at).toEqual(sameSession[0]?.recorded_at);
      expect(row.last_logged_at).toEqual(sameSession.at(-1)?.recorded_at);
    }
  });

  it.each(["board", "gym"] as const)(
    "does not let unknown %s identity bridge conflicting known identities",
    async (field) => {
      await write([
        { time: "2026-11-10T01:00:00Z", [field]: "A" },
        { time: "2026-11-10T01:01:00Z" },
        { time: "2026-11-10T01:02:00Z", [field]: "B" },
      ]);
      const rows = await sessions();
      expect(rows.map((row) => row.session_id)).toEqual([
        rows[0]?.activity_id,
        rows[0]?.activity_id,
        rows[2]?.activity_id,
      ]);
    },
  );

  it.each([
    {
      label: "gym change resets unknown board",
      first: { board: "A", gym: "1" },
      second: { gym: "2" },
      third: { board: "B", gym: "2" },
    },
    {
      label: "board change resets unknown gym",
      first: { board: "A", gym: "1" },
      second: { board: "B" },
      third: { board: "B", gym: "2" },
    },
  ])("starts only two sessions when $label", async ({ first, second, third }) => {
    await write([
      { time: "2026-11-10T01:00:00Z", ...first },
      { time: "2026-11-10T01:01:00Z", ...second },
      { time: "2026-11-10T01:02:00Z", ...third },
    ]);
    const rows = await sessions();
    expect(rows.map((row) => row.session_id)).toEqual([
      rows[0]?.activity_id,
      rows[1]?.activity_id,
      rows[1]?.activity_id,
    ]);
  });

  it("uses accepted boundaries when known identities alternate with unknown observations", async () => {
    await write([
      { time: "2026-11-10T01:00:00Z", board: "A", gym: "1" },
      { time: "2026-11-10T01:01:00Z", gym: "2" },
      { time: "2026-11-10T01:02:00Z", board: "B" },
      { time: "2026-11-10T01:03:00Z", gym: "1" },
    ]);
    const rows = await sessions();
    expect(rows.map((row) => row.session_id)).toEqual([
      rows[0]?.activity_id,
      rows[1]?.activity_id,
      rows[1]?.activity_id,
      rows[3]?.activity_id,
    ]);
  });

  it.each(["board", "gym"] as const)(
    "does not carry %s evidence across a ten-minute gap",
    async (field) => {
      await write([
        { time: "2026-11-10T01:00:00Z", [field]: "A" },
        { time: "2026-11-10T01:10:00Z" },
        { time: "2026-11-10T01:11:00Z", [field]: "B" },
      ]);
      const rows = await sessions();
      expect(rows.map((row) => row.session_id)).toEqual([
        rows[0]?.activity_id,
        rows[1]?.activity_id,
        rows[1]?.activity_id,
      ]);
    },
  );

  it.each([
    ["2026-11-09T23:59:00Z", "2026-11-10T00:01:00Z"],
    ["2026-11-01T01:59:00-07:00", "2026-11-01T01:01:00-08:00"],
  ])("keeps close instants together across midnight or DST: %s", async (first, second) => {
    await write([{ time: first, board: "A" }, { time: second }]);
    const rows = await sessions();
    expect(rows.map((row) => row.session_id)).toEqual([rows[0]?.activity_id, rows[0]?.activity_id]);
  });

  it("orders equal instants by native identity rather than generated UUID", async () => {
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, user_id, provider_id, external_id, canonical_type, provider_type, started_at)
      VALUES ('10000000-0000-4000-8000-000000000001', ${userId}, ${providerId}, 'log:z',
        'climbing', 'climbing_log', '2026-11-10T01:00:00Z'),
        ('f0000000-0000-4000-8000-000000000001', ${userId}, ${providerId}, 'log:a',
        'climbing', 'climbing_log', '2026-11-10T01:00:00Z')`);
    await write([
      { time: "2026-11-10T01:00:00Z", externalId: "log:z" },
      { time: "2026-11-10T01:00:00Z", externalId: "log:a" },
    ]);
    const rows = await sessions();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.session_id)).toEqual([rows[0]?.activity_id, rows[0]?.activity_id]);
    const [anchor] = await context.db.execute(
      sql`SELECT external_id FROM fitness.activity WHERE id = ${rows[0]?.session_id}::uuid`,
    );
    expect(anchor).toEqual({ external_id: "log:a" });
  });

  it("normalizes blank gym and absent board IDs and excludes inactive, detached and non-point records", async () => {
    await write(Array.from({ length: 8 }, (_, index) => ({ time: `2026-11-10T01:0${index}:00Z` })));
    await context.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET board = '{"name":"Board","externalId":null}' WHERE user_id = ${userId}`,
    );
    await context.db.execute(
      sql`UPDATE fitness.activity SET raw = '{"gymExternalId":"  "}' WHERE user_id = ${userId}`,
    );
    await context.db.execute(
      sql`UPDATE fitness.activity SET deleted_at = NOW() WHERE user_id = ${userId} AND external_id = 'log:2'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.activity SET provider_absent_at = NOW() WHERE user_id = ${userId} AND external_id = 'log:3'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW() WHERE user_id = ${userId} AND external_id = 'log:4'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET activity_id = NULL WHERE user_id = ${userId} AND external_id = 'log:5'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.activity SET canonical_type = 'cycling' WHERE user_id = ${userId} AND external_id = 'log:6'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.activity SET provider_type = 'climbing' WHERE user_id = ${userId} AND external_id = 'log:7'`,
    );
    const rows = await sessions();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_id === rows[0]?.activity_id)).toBe(true);
  });

  it("partitions source sessions by owner and provider", async () => {
    const otherUserId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${otherUserId}, 'Other climber')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name) VALUES ('session-other', 'Other source')`,
    );
    await write([{ time: "2026-11-10T01:00:00Z" }]);
    await write([{ time: "2026-11-10T01:00:00Z" }], otherUserId);
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "session-other",
      entries: [
        {
          externalId: "log:0",
          activityObservation: { recordedAt: "2026-11-10T01:01:00Z" },
          attempts: [],
        },
      ],
    });
    const rows = await sessions();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_id === row.activity_id)).toBe(true);
  });
});
