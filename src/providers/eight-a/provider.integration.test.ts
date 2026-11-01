import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity } from "../../db/schema/activity.ts";
import { climbingAttempt, climbingLogEntry } from "../../db/schema/climbing.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { createIntegrationMswFixture } from "../../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import { eightAHeader, eightARow } from "../climbing-file-test-helpers.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { EightAProvider, importEightAExportFile } from "./provider.ts";
import { eightAMatchingCsv, eightANativeRow } from "./test-helpers.ts";

const server = createIntegrationMswFixture();
describe("Vertical-Life direct sync persistence", () => {
  let context: TestContext;
  let rows: ReturnType<typeof eightANativeRow>[];
  let failLater: boolean;
  let malformed: boolean;
  let rejectAccess: boolean;
  let revokeRefresh: boolean;
  beforeAll(async () => {
    context = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
  });
  beforeEach(async () => {
    rows = [eightANativeRow()];
    failLater = false;
    malformed = false;
    rejectAccess = false;
    revokeRefresh = false;
    await ensureProvider(context.db, "eight-a", "8a.nu / Vertical-Life", undefined, TEST_USER_ID);
    await deleteTokens(context.db, "eight-a", TEST_USER_ID);
    server.use(
      http.post(
        "https://vlatka.vertical-life.info/auth/realms/Vertical-Life/protocol/openid-connect/token",
        async () => {
          if (revokeRefresh) return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
          return HttpResponse.json({
            access_token: `header.${Buffer.from(JSON.stringify({ scim_id: "owner" })).toString("base64url")}.signature`,
            refresh_token: "rotated-refresh",
            expires_in: 300,
          });
        },
      ),
      http.get(
        "https://vlcapi.vertical-life.info/profile/v1/web/users/find",
        async ({ request }) => {
          if (rejectAccess && request.headers.get("authorization") === "Bearer access")
            return new HttpResponse(null, { status: 401 });
          if (request.headers.get("authorization") !== "Bearer access")
            expect(await loadTokens(context.db, "eight-a", TEST_USER_ID)).toMatchObject({
              refreshToken: "rotated-refresh",
            });
          return HttpResponse.json({ uuid: "owner", userSlug: "climber" });
        },
      ),
      http.get(
        "https://vlcapi.vertical-life.info/ascent/v1/web/users/climber/ascents",
        ({ request }) => {
          const url = new URL(request.url),
            pageIndex = Number(url.searchParams.get("pageIndex"));
          if (failLater && pageIndex === 1) return new HttpResponse(null, { status: 503 });
          if (malformed) return HttpResponse.json({ success: false });
          return HttpResponse.json({
            ascents:
              url.searchParams.get("category") === "bouldering" && pageIndex === 0 ? rows : [],
            totalItems: rows.length,
            pageIndex,
          });
        },
      ),
    );
  });
  afterEach(async () => {
    server.resetHandlers();
    await context.db.delete(climbingLogEntry).where(eq(climbingLogEntry.providerId, "eight-a"));
    await context.db.delete(activity).where(eq(activity.providerId, "eight-a"));
  });
  afterAll(async () => {
    server.deactivate();
    await context.cleanup();
  });
  async function connect(userId = TEST_USER_ID) {
    await ensureProvider(context.db, "eight-a", "8a.nu / Vertical-Life", undefined, userId);
    await saveTokens(
      context.db,
      "eight-a",
      {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date("2099-01-01"),
        providerAccountId: "owner",
        scopes: null,
      },
      userId,
    );
  }
  const sync = (userId = TEST_USER_ID) =>
    new EightAProvider().sync(new SyncRun({ db: context.db, userId, window: SyncWindow.full() }));
  const upload = (...csv: string[]) =>
    importEightAExportFile(context.db, `${eightAHeader}\n${csv.join("\n")}`, TEST_USER_ID);
  const logs = () =>
    context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.providerId, "eight-a"));

  it("propagates cancellation during profile reads without writing history", async () => {
    await connect();
    const controller = new AbortController();
    const reason = new Error("Vertical-Life sync cancelled");
    server.use(
      http.get("https://vlcapi.vertical-life.info/profile/v1/web/users/find", () => {
        controller.abort(reason);
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(
      new EightAProvider().sync(
        new SyncRun({
          db: context.db,
          userId: TEST_USER_ID,
          window: SyncWindow.full(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow(reason);
    expect(await logs()).toEqual([]);
  });
  it("preserves projects without inventing tries and expands only positive source counts", async () => {
    rows = [
      eightANativeRow({ ascentId: 123, project: true, type: null, tries: 0 }),
      eightANativeRow({ ascentId: 124, project: true, type: null, tries: 3 }),
    ];
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 2, errors: [] });
    const records = await logs();
    const unknown = records.find((entry) => entry.externalId?.endsWith(":123"));
    const known = records.find((entry) => entry.externalId?.endsWith(":124"));
    if (!unknown || !known) throw new Error("Expected both projects");
    expect(unknown.raw).toMatchObject({ project: true, tries: 0 });
    expect(
      await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, unknown.id)),
    ).toEqual([]);
    expect(
      await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, known.id)),
    ).toHaveLength(3);
  });

  it("migrates a unique CSV identity in place, retaining manual attachment, attempts and both payloads", async () => {
    await upload(eightAMatchingCsv());
    const [original] = await logs();
    if (!original) throw new Error("Expected CSV log");
    const originalAttempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, original.id));
    const [attachment] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId: "eight-a",
        externalId: "attachment",
        canonicalType: "climbing",
        providerType: "manual",
        startedAt: new Date("2026-09-01"),
      })
      .returning();
    if (!attachment) throw new Error("Expected attachment");
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: attachment.id })
      .where(eq(climbingLogEntry.id, original.id));
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toMatchObject([
      {
        id: original.id,
        activityId: attachment.id,
        externalId: "eight-a:native:bouldering:eight_a:123",
        raw: { native: rows[0], csv: original.raw },
      },
    ]);
    expect(
      (
        await context.db
          .select()
          .from(climbingAttempt)
          .where(eq(climbingAttempt.climbingLogEntryId, original.id))
      ).map((a) => a.id),
    ).toEqual(originalAttempts.map((a) => a.id));
    await upload(eightAMatchingCsv());
    expect(await sync()).toMatchObject({ errors: [] });
    expect(await logs()).toHaveLength(1);
  });
  it("keeps repeated uploads from reverting native edits or richer climb facts", async () => {
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    await upload(eightAMatchingCsv());
    rows = [eightANativeRow({ comment: "new native note" })];
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await logs();
    expect(before).toMatchObject([{ notes: "new native note" }]);
    await expect(upload(eightAMatchingCsv({ comment: "new native note" }))).rejects.toThrow(
      /unique exact match/i,
    );
    expect(await logs()).toEqual(before);
    await upload(eightAMatchingCsv());
    await upload(eightAMatchingCsv());
    expect(await logs()).toEqual(before);
  });
  it("rejects unmatched or edited uploads atomically after connection", async () => {
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await logs();
    await expect(
      upload(eightAMatchingCsv(), eightAMatchingCsv({ name: "Unmatched climb" })),
    ).rejects.toThrow(/unique exact match/i);
    await expect(upload(eightAMatchingCsv({ comment: "edited CSV" }))).rejects.toThrow(
      /unique exact match/i,
    );
    expect(await logs()).toEqual(before);
  });
  it("rejects contradictory source areas before migrating legacy identities", async () => {
    await upload(eightAMatchingCsv({ area_name: "Area B" }));
    const before = await logs();
    rows = [eightANativeRow({ areaName: "Area A" })];
    await connect();
    expect(await sync()).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringMatching(/unique exact match/i) })],
    });
    expect(await logs()).toEqual(before);
  });
  it("rejects edits to retained CSV provenance without any partial raw updates", async () => {
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    await upload(eightAMatchingCsv());
    const before = await logs();
    const edits: Array<Record<string, string>> = [
      { rating: "5" },
      { repeats: "10" },
      { area_name: "Other area" },
    ];
    for (const changed of edits) {
      await expect(upload(eightAMatchingCsv(), eightAMatchingCsv(changed))).rejects.toThrow(
        /unique exact match/i,
      );
      expect(await logs()).toEqual(before);
    }
  });
  it("binds the correct area when climb and crag names are repeated", async () => {
    await upload(eightAMatchingCsv({ area_name: "Area A" }));
    const [original] = await logs();
    rows = [
      eightANativeRow({ areaName: "Area A" }),
      eightANativeRow({ ascentId: 124, areaName: "Area B" }),
    ];
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 2, errors: [] });
    const saved = await logs();
    expect(saved).toHaveLength(2);
    expect(saved.find((row) => row.id === original?.id)?.externalId).toBe(
      "eight-a:native:bouldering:eight_a:123",
    );
  });
  it("rejects ambiguous legacy occurrences without changing IDs, attachments or raw", async () => {
    await upload(eightAMatchingCsv(), eightAMatchingCsv());
    const before = await logs();
    await connect();
    expect(await sync()).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringMatching(/unique exact match/i) })],
    });
    expect(await logs()).toEqual(before);
  });
  it("requires all existing CSV history to match before switching to native sync", async () => {
    await upload(eightAMatchingCsv(), eightAMatchingCsv({ name: "Missing remotely" }));
    const before = await logs();
    await connect();
    expect(await sync()).toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringMatching(/existing CSV/i) })],
    });
    expect(await logs()).toEqual(before);
  });
  it("does not retire or update history after a failed or malformed fetch", async () => {
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await logs();
    rows = [eightANativeRow({ comment: "partial update" })];
    failLater = true;
    await expect(sync()).rejects.toMatchObject({ name: "ProviderServiceUnavailableError" });
    expect(await logs()).toEqual(before);
    failLater = false;
    malformed = true;
    expect(await sync()).toMatchObject({ recordsSynced: 0, errors: [expect.anything()] });
    expect(await logs()).toEqual(before);
  });
  it("reconciles complete native absence and restores the same occurrence", async () => {
    await connect();
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const [original] = await logs();
    rows = [];
    expect(await sync()).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await logs()).toMatchObject([{ id: original?.id, providerAbsentAt: expect.any(Date) }]);
    rows = [eightANativeRow()];
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toMatchObject([{ id: original?.id, providerAbsentAt: null }]);
  });
  it("saves rotated authorization before data reads and surfaces revoked refresh", async () => {
    await connect();
    rejectAccess = true;
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await loadTokens(context.db, "eight-a", TEST_USER_ID)).toMatchObject({
      refreshToken: "rotated-refresh",
    });
    const saved = await loadTokens(context.db, "eight-a", TEST_USER_ID);
    if (!saved) throw new Error("Expected tokens");
    await saveTokens(context.db, "eight-a", { ...saved, expiresAt: new Date(0) }, TEST_USER_ID);
    revokeRefresh = true;
    expect(await sync()).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringMatching(/Reconnect/) })],
    });
    expect(await logs()).toHaveLength(1);
  });
  it("isolates native identities and absence between users", async () => {
    const other = randomUUID();
    await context.db.insert(userProfile).values({ id: other, name: "Other climber" });
    await connect();
    await connect(other);
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await sync(other)).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toHaveLength(2);
    rows = [];
    expect(await sync(other)).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(
      await context.db
        .select()
        .from(climbingLogEntry)
        .where(
          and(
            eq(climbingLogEntry.providerId, "eight-a"),
            eq(climbingLogEntry.userId, TEST_USER_ID),
          ),
        ),
    ).toMatchObject([{ providerAbsentAt: null }]);
    expect(
      await context.db
        .select()
        .from(climbingLogEntry)
        .where(and(eq(climbingLogEntry.providerId, "eight-a"), eq(climbingLogEntry.userId, other))),
    ).toMatchObject([{ providerAbsentAt: expect.any(Date) }]);
  });
});

describe("8a.nu file import persistence", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    await context.cleanup();
  });
  it("keeps source occurrences idempotent/additive and preserves an attached activity", async () => {
    const first = eightARow({ type: "f", tries: "1" });
    const duplicate = eightARow({ type: "rp", tries: "0" });
    expect(
      await importEightAExportFile(
        context.db,
        `${eightAHeader}\n${first}\n${duplicate}\n${duplicate}`,
        TEST_USER_ID,
      ),
    ).toMatchObject({ recordsSynced: 3, errors: [] });
    const original = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "eight-a"));

    const entry = original.find((log) => log.raw && JSON.stringify(log.raw).includes('"f"'));
    if (!entry) throw new Error("Expected imported flash");
    const [attached] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId: "eight-a",
        externalId: "test-attachment",
        canonicalType: "climbing",
        providerType: "test",
        startedAt: new Date("2026-09-01T12:00:00Z"),
      })
      .returning();
    if (!attached) throw new Error("Expected attachment activity");
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: attached.id })
      .where(eq(climbingLogEntry.id, entry.id));
    await importEightAExportFile(
      context.db,
      `${eightAHeader}\n${duplicate}\n${first}\n${duplicate}`,
      TEST_USER_ID,
    );
    await importEightAExportFile(context.db, `${eightAHeader}\n${first}`, TEST_USER_ID);
    const saved = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "eight-a"));
    expect(saved).toHaveLength(3);
    expect(saved.find((log) => log.id === entry.id)).toMatchObject({
      activityId: attached.id,
      providerAbsentAt: null,
    });
    const attempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
    expect(attempts).toEqual([expect.objectContaining({ sourceResult: "f" })]);
    expect(
      await context.db.select().from(activity).where(eq(activity.providerId, "eight-a")),
    ).toHaveLength(1);
  });
});
