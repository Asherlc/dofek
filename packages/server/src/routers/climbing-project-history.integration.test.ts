import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SourceClimbingLogEntry } from "../../../../src/db/climbing-log-sync.ts";
import { climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { AuroraBoardClient } from "../../../../src/lib/aurora-board-client.ts";
import { createIntegrationMswFixture } from "../../../../src/test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import {
  seedClimbingActivity,
  seedClimbingLog,
} from "../repositories/climbing-integration-test-helpers.ts";
import type { Context } from "../trpc.ts";
import { climbingRouter } from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(climbingRouter);
const mswServer = createIntegrationMswFixture();
const auroraTokens = {
  accessToken: "session",
  refreshToken: null,
  expiresAt: new Date("2099-12-31T00:00:00Z"),
  scopes: null,
  providerAccountId: "42",
};
const route = { kind: "route", setting: "indoor", name: "Juniper Wall" } as const;
const boulder = { kind: "boulder", setting: "outdoor", name: "Chalk Line" } as const;
const failedLead = { scope: "climb", ropeMethod: "lead", sourceResult: "Attempt" } as const;
const cleanLead = {
  scope: "climb",
  ropeMethod: "lead",
  sourceResult: "Redpoint",
  qualifier: "free-send",
} as const;

describe("climbing project history", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "kaya", "Kaya", undefined, TEST_USER_ID);
    await ensureProvider(context.db, "boardsesh", "BoardSesh", undefined, TEST_USER_ID);
    await ensureProvider(context.db, "kilter", "Kilter Board", undefined, TEST_USER_ID);
    await ensureProvider(
      context.db,
      "mountain-project",
      "Mountain Project",
      undefined,
      TEST_USER_ID,
    );
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, TEST_USER_ID);
    await ensureProvider(context.db, "aurora-board", "Aurora Board", undefined, TEST_USER_ID);
    await ensureProvider(context.db, "tension", "Tension Board", undefined, TEST_USER_ID);
    mswServer.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
  });
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => {
    mswServer.deactivate();
    await context?.cleanup();
  });

  function api(options: Partial<Context> = {}) {
    return createCaller({ db: context.db, userId: TEST_USER_ID, timezone: "UTC", ...options });
  }

  function seed(
    source: SourceClimbingLogEntry["climb"],
    day: string | null,
    attempts: SourceClimbingLogEntry["attempts"],
    fields: Partial<SourceClimbingLogEntry> = {},
    providerId = "kaya",
  ) {
    return seedClimbingLog(context.db, providerId, {
      externalId: randomUUID(),
      discipline: "rock_climbing",
      climbedOn: day,
      climb: source,
      attempts,
      ...fields,
    });
  }

  it("coalesces same-day records and reports distinct whole-climb and lead milestones as of the selected log", async () => {
    const target = { ...route, externalId: "juniper" };
    const attached = await seedClimbingActivity(
      context.db,
      "kaya",
      randomUUID(),
      new Date("2026-11-07T21:00:00Z"),
    );
    await seed(target, "2026-11-06", [failedLead], { activityId: attached.id });
    const topRope = await seed(target, "2026-11-09", [{ ...cleanLead, ropeMethod: "top_rope" }]);
    await seed(target, "2026-11-11", [failedLead]);
    await seed(target, "2026-11-13", [failedLead]);
    const lead = await seed(target, "2026-11-13", [cleanLead]);
    const repeat = await seed(target, "2026-11-14", [
      { ...cleanLead, sourceResult: "Repeat", hadCompletedBefore: true },
    ]);
    await seed({ ...target, externalId: "another-gym-route" }, "2026-11-05", [cleanLead]);
    await seed({ ...target, setting: "outdoor", externalId: "outdoor-route" }, "2026-11-05", [
      cleanLead,
    ]);
    const caller = api();
    expect(await caller.projectHistory({ logEntryId: lead })).toMatchObject({
      throughDate: "2026-11-13",
      days: [
        { date: "2026-11-06", outcome: "unsuccessful" },
        { date: "2026-11-09", outcome: "send" },
        { date: "2026-11-11", outcome: "unsuccessful" },
        { date: "2026-11-13", outcome: "send" },
      ],
      firstSend: { date: "2026-11-09", sessionCount: 2, method: "top_rope" },
      methodFirstSend: { date: "2026-11-13", sessionCount: 3, method: "lead" },
    });
    expect(await caller.projectHistory({ logEntryId: topRope })).toMatchObject({
      throughDate: "2026-11-09",
      sessionCount: 2,
    });
    expect(await caller.projectHistory({ logEntryId: repeat })).toMatchObject({
      sessionCount: 5,
      firstSend: { date: "2026-11-09", sessionCount: 2, method: "top_rope" },
      methodFirstSend: { date: "2026-11-13", sessionCount: 3, method: "lead" },
    });
  });

  it("preserves unsuccessful, unknown, and partial outcomes while excluding pitch-only and retired logs", async () => {
    const target = { ...boulder, externalId: "chalk-line" };
    await seed(target, "2026-11-04", [{ scope: "climb", sourceCompleted: false }], {
      reportedAttemptCounts: [{ scope: "climb", count: 4 }],
    });
    await seed(target, "2026-11-12", [{ scope: "climb", sourceResult: "Attempt" }]);
    await seed(target, "2026-11-13", [
      { scope: "pitch", sourceResult: "Send", qualifier: "free-send" },
    ]);
    const retired = await seed(target, "2026-11-15", [
      { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
    ]);
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, retired));
    const latest = await seed(target, "2026-11-17", [{ scope: "climb", sourceCompleted: true }]);

    expect(await api().projectHistory({ logEntryId: latest })).toMatchObject({
      sessionCount: 3,
      unsuccessfulSessionCount: 2,
      unknownSessionCount: 1,
      firstSend: null,
      days: [
        { date: "2026-11-04", outcome: "unsuccessful" },
        { date: "2026-11-12", outcome: "unsuccessful" },
        { date: "2026-11-17", outcome: "unknown" },
      ],
    });
  });

  it("shows a clean first visit and keeps an earlier first send unknown when only a repeat was recorded", async () => {
    const flash = await seed({ ...boulder, externalId: "flash" }, "2026-11-09", [
      { scope: "climb", sourceResult: "Flash", qualifier: "free-flash" },
    ]);
    const redpoint = await seed({ ...route, externalId: "redpoint" }, "2026-11-10", [cleanLead]);
    const repeat = await seed({ ...boulder, externalId: "repeat" }, "2026-11-09", [
      { scope: "climb", sourceResult: "Repeat", qualifier: "free-send", hadCompletedBefore: true },
    ]);
    const caller = api();
    expect(await caller.projectHistory({ logEntryId: flash })).toMatchObject({
      firstSend: { date: "2026-11-09", sessionCount: 1 },
      repeatBeforeFirstSend: false,
    });
    expect(await caller.projectHistory({ logEntryId: redpoint })).toMatchObject({
      firstSend: { date: "2026-11-10", sessionCount: 1 },
      earlierSessionsUnknown: true,
    });
    expect(await caller.projectHistory({ logEntryId: repeat })).toMatchObject({
      firstSend: null,
      repeatBeforeFirstSend: true,
      days: [{ date: "2026-11-09", outcome: "send" }],
    });
  });

  it("uses only accessible dates and hides logs from other owners", async () => {
    const target = { ...route, externalId: "permission" };
    const prior = await seed(target, "2026-11-04", [cleanLead]);
    const current = await seed(target, "2026-11-12", [failedLead]);
    const caller = api({
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-11-08",
        endDateExclusive: "2026-11-15",
      },
    });
    expect(await caller.projectHistory({ logEntryId: current })).toMatchObject({
      firstSend: null,
      sessionCount: 1,
    });
    await expect(caller.projectHistory({ logEntryId: prior })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      api({ userId: randomUUID() }).projectHistory({ logEntryId: current }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses BoardSesh climb time in the local timezone and isolates different board variants", async () => {
    const target = { ...boulder, setting: "indoor", externalId: "kilter:climb:normal" } as const;
    const board = { name: "Kilter Board", externalId: null };
    const atAngle = (value: number, timestamp: string) => ({
      board,
      wallAngle: { value, unit: "degrees" as const },
      raw: { climbedAt: timestamp },
    });
    await seed(
      target,
      null,
      [{ scope: "climb", sourceResult: "attempt", sourceCompleted: false }],
      atAngle(30, "2026-11-06 04:00:00"),
      "boardsesh",
    );
    await seed(
      target,
      null,
      [{ scope: "climb", sourceResult: "send", sourceCompleted: true }],
      atAngle(45, "2026-11-06 04:00:00"),
      "boardsesh",
    );
    await seed(
      { ...target, externalId: "kilter:climb:mirror" },
      null,
      [{ scope: "climb", sourceResult: "send", sourceCompleted: true }],
      atAngle(30, "2026-11-06 04:00:00"),
      "boardsesh",
    );
    const current = await seed(
      target,
      null,
      [{ scope: "climb", sourceResult: "send", sourceCompleted: true }],
      atAngle(30, "2026-11-08T02:30:00Z"),
      "boardsesh",
    );
    expect(
      await api({ timezone: "America/Los_Angeles" }).projectHistory({ logEntryId: current }),
    ).toMatchObject({
      firstSend: { date: "2026-11-07", sessionCount: 2 },
      days: [
        { date: "2026-11-05", outcome: "unsuccessful" },
        { date: "2026-11-07", outcome: "send" },
      ],
    });
  });

  it("keeps missing identity or climb day unavailable and generic imported ticks unknown", async () => {
    const unidentified = await seed({ ...boulder, externalId: null }, "2026-11-04", [
      { scope: "climb" },
    ]);
    const logTimestamp = await seed(
      { ...boulder, setting: "indoor", externalId: "kilter-id" },
      null,
      [{ scope: "climb", sourceCompleted: true }],
      {
        activityObservation: { recordedAt: "2026-11-12T12:00:00Z" },
      },
      "kilter",
    );
    const generic = await seed(
      { ...boulder, externalId: "openbeta-id" },
      "2026-11-04",
      [{ scope: "climb" }],
      {},
      "openbeta",
    );
    const topRopeTick = await seed(
      { ...route, externalId: "mountain-project-id", setting: "outdoor" },
      "2026-11-04",
      [{ scope: "climb", ropeMethod: "top_rope" }],
      {},
      "mountain-project",
    );
    const caller = api();
    expect(await caller.projectHistory({ logEntryId: unidentified })).toBeNull();
    expect(await caller.projectHistory({ logEntryId: logTimestamp })).toBeNull();
    expect(await caller.projectHistory({ logEntryId: generic })).toMatchObject({
      firstSend: null,
      unknownSessionCount: 1,
    });
    expect(await caller.projectHistory({ logEntryId: topRopeTick })).toMatchObject({
      firstSend: null,
      methodFirstSend: null,
      unknownSessionCount: 1,
    });
  });

  it("qualifies named Aurora boulder sends and leaves generic completions and other providers unknown", async () => {
    const climbUuid = "aurora:climb:clean";
    const ascent = (uuid: string, day: string, attemptId: number | null) => ({
      uuid,
      user_id: 42,
      climb_uuid: climbUuid,
      climbed_at: `${day} 12:00:00`,
      angle: 40,
      wall_uuid: "aurora-wall",
      attempt_id: attemptId,
      is_mirror: false,
    });
    mswServer.use(
      http.post("https://auroraboardapp.com/sync", () =>
        HttpResponse.json({
          ascents: [
            ascent("flash", "2026-11-04", 1),
            ascent("redpoint", "2026-11-06", 2),
            ascent("generic", "2026-11-08", null),
            ascent("completed", "2026-11-10", 3),
            ascent("aid-flash", "2026-11-12", 4),
          ],
          attempts: [
            { id: 1, name: "Flash" },
            { id: 2, name: "Redpoint" },
            { id: 3, name: "Completed" },
            { id: 4, name: "Aid Flash" },
          ],
          _complete: true,
        }),
      ),
    );
    const client = new AuroraBoardClient(
      "aurora-board",
      "Aurora Board",
      "https://auroraboardapp.com",
    );
    const { entries } = await client.fetchLogbook(auroraTokens, async () => {});
    expect(entries).toHaveLength(5);
    const seeded = [];
    for (const entry of entries) {
      seeded.push(await seedClimbingLog(context.db, "aurora-board", entry));
    }
    const selected = seeded[seeded.length - 1];
    if (!selected) throw new Error("Expected the imported Aid Flash log");
    expect(await api().projectHistory({ logEntryId: selected })).toMatchObject({
      days: [
        { date: "2026-11-04", outcome: "send" },
        { date: "2026-11-06", outcome: "send" },
        { date: "2026-11-08", outcome: "unknown" },
        { date: "2026-11-10", outcome: "unknown" },
        { date: "2026-11-12", outcome: "unknown" },
      ],
      firstSend: { date: "2026-11-04", sessionCount: 1 },
    });

    const target = { ...boulder, setting: "indoor", externalId: climbUuid } as const;
    const atAngle = () => ({
      board: { name: "Aurora Board", externalId: "aurora-wall" },
      wallAngle: { value: 40, unit: "degrees" as const },
      raw: { is_mirror: false },
    });
    const tension = await seed(
      target,
      "2026-11-04",
      [{ scope: "climb", sourceCompleted: true, sourceResult: "Redpoint" }],
      atAngle(),
      "tension",
    );
    expect(await api().projectHistory({ logEntryId: tension })).toMatchObject({
      firstSend: { date: "2026-11-04", sessionCount: 1 },
      earlierSessionsUnknown: true,
    });

    const kilter = await seed(
      target,
      "2026-11-04",
      [{ scope: "climb", sourceCompleted: true, sourceResult: "Flash" }],
      atAngle(),
      "kilter",
    );
    expect(await api().projectHistory({ logEntryId: kilter })).toMatchObject({
      days: [{ date: "2026-11-04", outcome: "unknown" }],
      firstSend: null,
    });
  });

  it("keeps opposite Aurora mirrors with the same climb UUID and angle separate", async () => {
    const target = {
      ...boulder,
      setting: "indoor",
      externalId: "aurora:climb:mirror-pair",
    } as const;
    const atMirror = (isMirror: boolean) => ({
      board: { name: "Aurora Board", externalId: "aurora-wall" },
      wallAngle: { value: 40, unit: "degrees" as const },
      raw: { is_mirror: isMirror },
    });
    await seed(
      target,
      "2026-11-04",
      [{ scope: "climb", sourceCompleted: false }],
      atMirror(false),
      "aurora-board",
    );
    const mirrored = await seed(
      target,
      "2026-11-06",
      [{ scope: "climb", sourceCompleted: false }],
      atMirror(true),
      "aurora-board",
    );
    expect(await api().projectHistory({ logEntryId: mirrored })).toMatchObject({
      days: [{ date: "2026-11-06", outcome: "unsuccessful" }],
      sessionCount: 1,
    });
  });

  it("leaves an unlabeled OpenBeta top-rope tick unknown while retaining its method", async () => {
    const target = { ...route, setting: "outdoor", externalId: "openbeta:top-rope-unlabeled" };
    const topRope = await seed(
      target,
      "2026-11-04",
      [{ scope: "climb", ropeMethod: "top_rope" }],
      { raw: { attemptType: null } },
      "openbeta",
    );
    expect(await api().projectHistory({ logEntryId: topRope })).toMatchObject({
      firstSend: null,
      unknownSessionCount: 1,
      days: [{ date: "2026-11-04", outcome: "unknown", method: "top_rope" }],
    });

    // A same-day failed lead must not hide the explicit unknown top-rope result.
    await seed(
      target,
      "2026-11-04",
      [{ scope: "climb", ropeMethod: "lead", sourceResult: "Attempt" }],
      {},
      "openbeta",
    );
    expect(await api().projectHistory({ logEntryId: topRope })).toMatchObject({
      firstSend: null,
      unsuccessfulSessionCount: 0,
      unknownSessionCount: 1,
      days: [{ date: "2026-11-04", outcome: "unknown" }],
    });
  });
});
