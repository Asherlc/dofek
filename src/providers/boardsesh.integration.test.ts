import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID as userId } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { BoardSeshProvider } from "./boardsesh.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const graphqlUrl = "https://ws.boardsesh.com/graphql";
const authUrl = "https://ws.boardsesh.com/auth/native/refresh";
const tick = (overrides: Record<string, unknown> = {}) => ({
  uuid: "tick-1",
  userId: "owner-1",
  boardType: "kilter",
  climbUuid: "climb-1",
  climbRevision: null,
  angle: 40,
  isMirror: false,
  status: "flash",
  attemptCount: 1,
  quality: 4,
  effectiveQuality: 5,
  difficulty: 20,
  effectiveDifficulty: 21,
  isBenchmark: true,
  comment: "felt good",
  climbedAt: "2026-11-01 10:00:00",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  sessionId: null,
  auroraType: null,
  auroraId: null,
  auroraSyncedAt: null,
  layoutId: 7,
  boardId: null,
  ...overrides,
});
const server = createIntegrationMswFixture();

describe("BoardSesh snapshot persistence", () => {
  let context: TestContext;
  let mode:
    | "complete"
    | "empty"
    | "partial"
    | "late-error"
    | "wrong-owner"
    | "wrong-board"
    | "duplicate"
    | "invalid-date"
    | "variants"
    | "edited"
    | "auth-reject"
    | "auth-reject-always";
  let requestOrder: string[];
  let provider: BoardSeshProvider;

  beforeAll(async () => {
    context = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    server.use(
      http.post(authUrl, () => {
        requestOrder.push("refresh");
        return HttpResponse.json({
          jwt: "rotated-access",
          refreshToken: "rotated-refresh",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }),
      http.post(graphqlUrl, async ({ request }) => {
        const body = z
          .object({ query: z.string(), variables: z.record(z.string(), z.unknown()).optional() })
          .parse(await request.json());
        const input = z
          .object({ input: z.object({ boardType: z.string() }).optional() })
          .parse(body.variables ?? {});
        if (body.query.includes("grades")) {
          requestOrder.push("grades");
          return HttpResponse.json({
            data: { authenticatedUserId: "owner-1", grades: [{ difficultyId: 20, name: "6c/V5" }] },
          });
        }
        requestOrder.push("ticks");
        if (mode === "partial" || (mode === "late-error" && input.input?.boardType === "spray"))
          return HttpResponse.json({ data: null, errors: [{ message: "upstream failure" }] });
        if (
          mode === "auth-reject-always" ||
          (mode === "auth-reject" && requestOrder.filter((entry) => entry === "ticks").length === 1)
        )
          return HttpResponse.json({
            data: null,
            errors: [{ message: "Authentication required to perform this operation" }],
          });
        if (mode === "empty")
          return HttpResponse.json({ data: { authenticatedUserId: "owner-1", ticks: [] } });
        let rows = input.input?.boardType === "kilter" ? [tick()] : [];
        if (input.input?.boardType === "kilter" && mode === "variants")
          rows = [
            tick(),
            tick({
              uuid: "tick-send",
              isMirror: true,
              status: "send",
              attemptCount: 3,
              difficulty: null,
            }),
            tick({
              uuid: "tick-attempt",
              climbUuid: "climb-attempt",
              status: "attempt",
              attemptCount: 2,
              difficulty: null,
            }),
          ];
        if (input.input?.boardType === "kilter" && mode === "edited")
          rows = [tick({ comment: "edited note" })];
        if (input.input?.boardType === "kilter" && mode === "invalid-date")
          rows = [tick({ climbedAt: "2026-02-31 10:00:00" })];
        if (mode === "wrong-owner") rows = [tick({ userId: "another-owner" })];
        if (mode === "wrong-board") rows = [tick({ boardType: "tension" })];
        if (mode === "duplicate" && input.input?.boardType === "tension")
          rows = [tick({ boardType: "tension" })];
        return HttpResponse.json({ data: { authenticatedUserId: "owner-1", ticks: rows } });
      }),
    );
  });

  beforeEach(async () => {
    mode = "complete";
    requestOrder = [];
    provider = new BoardSeshProvider();
    await ensureProvider(
      context.db,
      provider.id,
      provider.name,
      "https://ws.boardsesh.com",
      userId,
    );
    await saveTokens(
      context.db,
      provider.id,
      {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 60_000),
        scopes: null,
        providerAccountId: "owner-1",
      },
      userId,
    );
  });

  afterEach(async () => {
    await context.db.execute(
      sql`DELETE FROM fitness.climbing_log_entry WHERE user_id = ${userId}::uuid AND provider_id = 'boardsesh'`,
    );
    await context.db.execute(sql`DELETE FROM fitness.activity WHERE user_id = ${userId}::uuid`);
    await context.db.execute(
      sql`DELETE FROM fitness.climb WHERE user_id = ${userId}::uuid AND provider_id = 'boardsesh'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.area SET parent_area_id = NULL WHERE user_id = ${userId}::uuid`,
    );
    await context.db.execute(sql`DELETE FROM fitness.area WHERE user_id = ${userId}::uuid`);
    await context.db.execute(
      sql`DELETE FROM fitness.provider_connection WHERE user_id = ${userId}::uuid AND provider_id = 'boardsesh'`,
    );
  });

  afterAll(async () => {
    server.deactivate();
    await context.cleanup();
  });

  const run = () =>
    provider.sync(new SyncRun({ db: context.db, userId, window: SyncWindow.full() }));
  const rows = () =>
    context.db.execute(
      sql`SELECT external_id, provider_absent_at, raw FROM fitness.climbing_log_entry WHERE user_id = ${userId}::uuid AND provider_id = 'boardsesh' ORDER BY external_id`,
    );

  it("reads all board types and preserves raw tick identity, grades, statuses, layout, and UTC time", async () => {
    expect(await run()).toMatchObject({ errors: [], recordsSynced: 1 });
    const firstRows = await rows();
    requestOrder = [];
    expect(await run()).toMatchObject({ errors: [], recordsSynced: 1 });
    expect(await rows()).toEqual(firstRows);
    expect(requestOrder.filter((entry) => entry === "ticks")).toHaveLength(9);
    expect(await rows()).toMatchObject([
      {
        external_id: "boardsesh:tick:tick-1",
        provider_absent_at: null,
        raw: {
          uuid: "tick-1",
          quality: 4,
          effectiveQuality: 5,
          difficulty: 20,
          effectiveDifficulty: 21,
          isBenchmark: true,
          layoutId: 7,
          boardId: null,
        },
      },
    ]);
    const attempts = await context.db.execute(
      sql`SELECT source_completed, source_result, received_beta FROM fitness.climbing_attempt a JOIN fitness.climbing_log_entry l ON l.id = a.climbing_log_entry_id WHERE l.user_id = ${userId}::uuid AND l.provider_id = 'boardsesh'`,
    );
    expect(attempts).toMatchObject([
      { source_completed: true, source_result: "flash", received_beta: true },
    ]);
    const gradeRows = await context.db.execute(
      sql`SELECT value, system FROM fitness.climbing_log_entry_grade g JOIN fitness.climbing_log_entry l ON l.id = g.climbing_log_entry_id WHERE l.user_id = ${userId}::uuid AND l.provider_id = 'boardsesh' ORDER BY position`,
    );
    expect(gradeRows).toEqual([
      { value: "6c", system: "font" },
      { value: "V5", system: "v_scale" },
    ]);
    const activityRows = await context.db.execute(
      sql`SELECT started_at FROM fitness.activity WHERE user_id = ${userId}::uuid`,
    );
    expect(new Date(String(activityRows[0]?.started_at)).toISOString()).toBe(
      "2026-11-01T10:00:00.000Z",
    );
  });

  it.each(["partial", "wrong-owner", "wrong-board", "duplicate"] as const)(
    "keeps active rows when a %s snapshot is invalid",
    async (invalidMode) => {
      expect((await run()).errors).toEqual([]);
      mode = invalidMode;
      const result = await run();
      expect(result.errors).toHaveLength(1);
      expect(requestOrder).not.toContain("refresh");
      expect((await rows())[0]?.provider_absent_at).toBeNull();
    },
  );

  it("does not retire existing rows when the final board request fails", async () => {
    await run();
    mode = "late-error";
    requestOrder = [];
    const result = await run();
    expect(result.errors).toHaveLength(1);
    expect(requestOrder.filter((entry) => entry === "ticks")).toHaveLength(9);
    expect((await rows())[0]?.provider_absent_at).toBeNull();
  });

  it("preserves send and failed statuses, source counts, mirror identity, and unknown grades", async () => {
    mode = "variants";
    expect(await run()).toMatchObject({ errors: [], recordsSynced: 3 });
    const attempts = await context.db.execute(
      sql`SELECT DISTINCT l.external_id, a.source_completed, a.source_result FROM fitness.climbing_attempt a JOIN fitness.climbing_log_entry l ON l.id = a.climbing_log_entry_id WHERE l.user_id = ${userId}::uuid AND l.provider_id = 'boardsesh' AND a.source_result IS NOT NULL ORDER BY l.external_id`,
    );
    expect(attempts).toEqual([
      { external_id: "boardsesh:tick:tick-1", source_completed: true, source_result: "flash" },
      {
        external_id: "boardsesh:tick:tick-attempt",
        source_completed: false,
        source_result: "attempt",
      },
      { external_id: "boardsesh:tick:tick-send", source_completed: true, source_result: "send" },
    ]);
    const climbs = await context.db.execute(
      sql`SELECT c.external_id, l.external_id AS tick_id FROM fitness.climbing_log_entry l JOIN fitness.climb c ON c.id = l.climb_id WHERE l.user_id = ${userId}::uuid AND l.provider_id = 'boardsesh' ORDER BY tick_id`,
    );
    expect(climbs).toContainEqual({
      external_id: "kilter:climb-1:normal",
      tick_id: "boardsesh:tick:tick-1",
    });
    expect(climbs).toContainEqual({
      external_id: "kilter:climb-1:mirror",
      tick_id: "boardsesh:tick:tick-send",
    });
    expect(
      (await rows()).find((row) => row.external_id === "boardsesh:tick:tick-send")?.raw,
    ).toMatchObject({
      uuid: "tick-send",
      attemptCount: 3,
      boardId: null,
      difficulty: null,
      effectiveDifficulty: 21,
    });
    expect(
      await context.db.execute(
        sql`SELECT value FROM fitness.climbing_log_entry_grade g JOIN fitness.climbing_log_entry l ON l.id = g.climbing_log_entry_id WHERE l.user_id = ${userId}::uuid AND l.provider_id = 'boardsesh'`,
      ),
    ).toHaveLength(2);
  });

  it("applies edits to the existing tick identity and rejects malformed dates without reconciliation", async () => {
    await run();
    mode = "edited";
    expect((await run()).errors).toEqual([]);
    expect((await rows())[0]?.raw).toMatchObject({ comment: "edited note" });
    mode = "invalid-date";
    expect((await run()).errors).toHaveLength(1);
    expect((await rows())[0]?.provider_absent_at).toBeNull();
  });

  it("reconciles a complete empty snapshot and restores a later returned UUID", async () => {
    await run();
    mode = "empty";
    await run();
    expect((await rows())[0]?.provider_absent_at).not.toBeNull();
    mode = "complete";
    await run();
    expect((await rows())[0]?.provider_absent_at).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it("retries explicit HTTP 200 auth rejection once and persists rotated tokens before later reads", async () => {
    mode = "auth-reject";
    expect((await run()).errors).toEqual([]);
    expect(requestOrder.slice(0, 3)).toEqual(["ticks", "refresh", "ticks"]);
    await saveTokens(
      context.db,
      provider.id,
      {
        accessToken: "expired",
        refreshToken: "old-refresh",
        expiresAt: new Date(0),
        scopes: null,
        providerAccountId: "owner-1",
      },
      userId,
    );
    mode = "partial";
    requestOrder = [];
    expect((await run()).errors).toHaveLength(1);
    expect(requestOrder.slice(0, 2)).toEqual(["refresh", "ticks"]);
    expect(await loadTokens(context.db, provider.id, userId)).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
  });

  it("does not retry repeatedly when refreshed credentials are rejected and gives a reconnect error without a refresh token", async () => {
    mode = "auth-reject-always";
    const rejected = await run();
    expect(rejected.errors[0]?.message).toMatch(/reconnect/i);
    expect(requestOrder.filter((entry) => entry === "ticks")).toHaveLength(2);
    expect(requestOrder.filter((entry) => entry === "refresh")).toHaveLength(1);
    await saveTokens(
      context.db,
      provider.id,
      {
        accessToken: "expired",
        refreshToken: null,
        expiresAt: new Date(0),
        scopes: null,
        providerAccountId: "owner-1",
      },
      userId,
    );
    requestOrder = [];
    expect((await run()).errors[0]?.message).toMatch(/reconnect/i);
    expect(requestOrder).toEqual([]);
  });

  it("keeps two concurrent user snapshots in separate ownership scopes", async () => {
    const otherUserId = "00000000-0000-4000-8000-000000009992";
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id,name) VALUES (${otherUserId}::uuid,'BoardSesh Other') ON CONFLICT (id) DO NOTHING`,
    );
    await ensureProvider(
      context.db,
      provider.id,
      provider.name,
      "https://ws.boardsesh.com",
      otherUserId,
    );
    await saveTokens(
      context.db,
      provider.id,
      {
        accessToken: "access-other",
        refreshToken: "refresh-other",
        expiresAt: new Date(Date.now() + 60_000),
        scopes: null,
        providerAccountId: "owner-1",
      },
      otherUserId,
    );
    await Promise.all([
      run(),
      provider.sync(
        new SyncRun({ db: context.db, userId: otherUserId, window: SyncWindow.full() }),
      ),
    ]);
    const owned = await context.db.execute(
      sql`SELECT user_id, external_id FROM fitness.climbing_log_entry WHERE provider_id = 'boardsesh' AND user_id IN (${userId}::uuid, ${otherUserId}::uuid) ORDER BY user_id`,
    );
    expect(owned).toEqual([
      { user_id: expect.any(String), external_id: "boardsesh:tick:tick-1" },
      { user_id: expect.any(String), external_id: "boardsesh:tick:tick-1" },
    ]);
    expect(owned.map((row) => row.user_id)).toEqual([userId, otherUserId].sort());
    await context.db.execute(
      sql`DELETE FROM fitness.climbing_log_entry WHERE user_id = ${otherUserId}::uuid AND provider_id = 'boardsesh'`,
    );
    await context.db.execute(
      sql`DELETE FROM fitness.activity WHERE user_id = ${otherUserId}::uuid`,
    );
    await context.db.execute(
      sql`DELETE FROM fitness.climb WHERE user_id = ${otherUserId}::uuid AND provider_id = 'boardsesh'`,
    );
    await context.db.execute(
      sql`UPDATE fitness.area SET parent_area_id = NULL WHERE user_id = ${otherUserId}::uuid`,
    );
    await context.db.execute(sql`DELETE FROM fitness.area WHERE user_id = ${otherUserId}::uuid`);
    await context.db.execute(
      sql`DELETE FROM fitness.provider_connection WHERE user_id = ${otherUserId}::uuid AND provider_id = 'boardsesh'`,
    );
  });
});
