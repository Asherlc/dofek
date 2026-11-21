import { randomUUID } from "node:crypto";
import { type FreeRockGradeSystem, gradeSortValue } from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climb, climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { parseEightAAscentPage } from "../../../../src/providers/eight-a/ascent.ts";
import { ClimbingBestOnsightRepository } from "./climbing-best-onsight-repository.ts";

describe("ClimbingBestOnsightRepository PostgreSQL result", () => {
  let context: TestContext;
  const now = new Date("2026-11-22T02:00:00Z");
  const timezone = "America/Los_Angeles";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
    await ensureProvider(context.db, "eight-a", "8a.nu / Vertical-Life", undefined, userId);
  });

  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.delete(area);
    await context.db.delete(activity);
  });

  afterAll(async () => {
    await context.cleanup();
  });

  const repo = () => new ClimbingBestOnsightRepository(context.db, userId, timezone);

  async function write(
    source: SourceClimbingLogEntry,
    providerId = "openbeta",
    owner = userId,
  ): Promise<string> {
    const result = await persistClimbingLogEntries(context.db, {
      userId: owner,
      providerId,
      entries: [source],
    });
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected a persisted climbing log");
    return id;
  }

  function boulderOnsight(
    externalId: string,
    climbedOn: string,
    grade: { value: string; system: FreeRockGradeSystem } | null,
    setting: "indoor" | "outdoor" | null = "indoor",
    reportedOnly = false,
  ): SourceClimbingLogEntry {
    return {
      externalId,
      climbedOn,
      discipline: "rock_climbing",
      climb: {
        externalId: `${externalId}-climb`,
        name: `Climb ${externalId}`,
        kind: "boulder",
        setting,
        ...(reportedOnly || !grade ? {} : { publishedGrades: [grade] }),
      },
      ...(reportedOnly && grade ? { reportedGrades: [grade] } : {}),
      attempts: [{ scope: "climb", qualifier: "free-onsight", sourceResult: "Onsight" }],
    };
  }

  it("returns the complete empty matrix with local 12-month calendar boundaries", async () => {
    const result = await repo().getBestOnsight(now);
    expect(result.startDate).toBe("2025-11-22");
    expect(result.endDate).toBe("2026-11-21");
    expect(result.rows.map((row) => row.type)).toEqual([
      "bouldering",
      "lead",
      "top_rope",
      "follow",
      "unroped",
    ]);
    expect(result.rows.every((row) => row.gym === null && row.outdoor === null)).toBe(true);

    const leap = await repo().getBestOnsight(new Date("2024-02-29T12:00:00Z"));
    expect(leap.startDate).toBe("2023-03-01");
    expect(leap.endDate).toBe("2024-02-29");
  });

  it("includes both endpoints and excludes the anniversary and future dates", async () => {
    await write(boulderOnsight("anniversary", "2025-11-21", { value: "V9", system: "v_scale" }));
    const startDay = await write(
      boulderOnsight("start-day", "2025-11-22", { value: "V8", system: "v_scale" }),
    );
    await write(boulderOnsight("end-day", "2026-11-21", { value: "V7", system: "v_scale" }));
    await write(boulderOnsight("future-day", "2026-11-22", { value: "V10", system: "v_scale" }));

    const result = await repo().getBestOnsight(now);
    expect(result.rows[0].gym).toMatchObject({
      grade: "V8",
      gradeSystem: "v_scale",
      recordId: startDay,
    });
  });

  it("follows the recorded climb date for an attached log and the newer ascent on a tie", async () => {
    const activityId = randomUUID();
    await context.db.insert(activity).values({
      id: activityId,
      userId,
      providerId: "openbeta",
      externalId: randomUUID(),
      canonicalType: "climbing",
      providerType: "climbing",
      startedAt: new Date("2025-12-01T12:00:00Z"),
      endedAt: new Date("2025-12-01T14:00:00Z"),
    });
    const attached = await write({
      ...boulderOnsight("attached-recorded-date", "2026-11-21", {
        value: "V5",
        system: "v_scale",
      }),
      activityId,
    });
    await write(boulderOnsight("detached-older", "2026-06-01", { value: "V5", system: "v_scale" }));

    const result = await repo().getBestOnsight(now);
    expect(result.rows[0].gym).toMatchObject({ grade: "V5", recordId: attached });
  });

  it("ranks an unattached eight-a outdoor boulder by its native reported onsight", async () => {
    const [source] = parseEightAAscentPage(
      {
        ascents: [
          {
            ascentId: 123,
            platform: "eight_a",
            date: "2026-10-01T12:00:00+00:00",
            difficulty: "8a",
            zlaggableName: "Eight-a outdoor boulder",
            cragName: "Example Forest",
            type: "OS",
            repeat: false,
            project: false,
            duplicate: false,
            tries: 1,
          },
        ],
        totalItems: 1,
        pageIndex: 0,
      },
      "bouldering",
      0,
    );
    if (!source) throw new Error("Expected an eight-a ascent fixture");
    const recordId = await write(source, "eight-a");
    const result = await repo().getBestOnsight(now);
    expect(result.rows[0].outdoor).toEqual({
      grade: "8a",
      gradeSystem: "font",
      providerId: "eight-a",
      recordId,
    });
    expect(result.rows[0].gym).toBeNull();
  });

  it("does not let ineligible ascents displace a confirmed whole-climb onsight", async () => {
    const winner = await write(
      boulderOnsight("confirmed-winner", "2026-09-01", { value: "V3", system: "v_scale" }),
    );
    await write({
      ...boulderOnsight("unlabeled-completion", "2026-09-02", { value: "V10", system: "v_scale" }),
      attempts: [{ scope: "climb" }],
    });
    await write({
      ...boulderOnsight("flash", "2026-09-03", { value: "V11", system: "v_scale" }),
      attempts: [{ scope: "climb", qualifier: "free-flash", sourceResult: "Flash" }],
    });
    await write({
      ...boulderOnsight("prior-attempt", "2026-09-04", { value: "V12", system: "v_scale" }),
      attempts: [
        {
          scope: "climb",
          qualifier: "free-onsight",
          sourceResult: "Onsight",
          priorFailedAttemptsGroundUp: true,
        },
      ],
    });
    await write({
      ...boulderOnsight("aid", "2026-09-05", { value: "V13", system: "v_scale" }),
      attempts: [{ scope: "climb", qualifier: "aid-onsight", sourceResult: "Aid onsight" }],
    });
    await write({
      ...boulderOnsight("pitch-only", "2026-09-06", { value: "V14", system: "v_scale" }),
      attempts: [
        {
          scope: "pitch",
          pitch: { number: 1 },
          qualifier: "free-onsight",
          sourceResult: "Onsight",
        },
      ],
    });
    await write(boulderOnsight("retired", "2026-09-07", { value: "V15", system: "v_scale" }));
    await context.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at = NOW() WHERE external_id = ${"retired"}`,
    );
    await write(
      boulderOnsight("unknown-setting", "2026-09-08", { value: "V16", system: "v_scale" }, null),
    );

    const otherUser = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${otherUser}, 'Other onsight user') ON CONFLICT DO NOTHING`,
    );
    await write(
      boulderOnsight("other-user", "2026-09-09", { value: "V17", system: "v_scale" }),
      "openbeta",
      otherUser,
    );
    await write({
      externalId: "unknown-method",
      climbedOn: "2026-09-10",
      discipline: "rock_climbing",
      climb: {
        externalId: "unknown-method-climb",
        name: "Unknown method",
        kind: "route",
        setting: "indoor",
        publishedGrades: [{ value: "5.14a", system: "yds" }],
      },
      attempts: [{ scope: "climb", qualifier: "free-onsight", sourceResult: "Onsight" }],
    });

    const result = await repo().getBestOnsight(now);
    expect(result.rows[0].gym).toMatchObject({ grade: "V3", recordId: winner });
    expect(result.rows[0].outdoor).toBeNull();
    expect(result.rows.slice(1).every((row) => row.gym === null && row.outdoor === null)).toBe(
      true,
    );
  });

  it("respects the analytics access window on the recorded climb date", async () => {
    const accessible = await write(
      boulderOnsight("accessible-date", "2026-11-21", { value: "V4", system: "v_scale" }),
    );
    await write(
      boulderOnsight("inaccessible-date", "2026-06-01", { value: "V8", system: "v_scale" }),
    );

    const limited = new ClimbingBestOnsightRepository(context.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-11-20",
      endDateExclusive: "2026-11-22",
    });
    const result = await limited.getBestOnsight(now);
    expect(result.rows[0].gym).toMatchObject({ grade: "V4", recordId: accessible });
  });

  it("assigns a mixed-method route only to the onsight attempt's method", async () => {
    const recordId = await write({
      externalId: "mixed-method",
      climbedOn: "2026-10-01",
      discipline: "rock_climbing",
      climb: {
        externalId: "mixed-method-climb",
        name: "Mixed method",
        kind: "route",
        setting: "indoor",
        publishedGrades: [{ value: "5.10a", system: "yds" }],
      },
      attempts: [
        { scope: "climb", qualifier: "free-onsight", sourceResult: "Onsight", ropeMethod: "lead" },
        { scope: "climb", sourceCompleted: true, ropeMethod: "top_rope" },
      ],
    });
    const result = await repo().getBestOnsight(now);
    expect(result.rows[1].gym).toMatchObject({ grade: "5.10a", recordId });
    expect(result.rows[2].gym).toBeNull();
  });

  it("prefers a published grade over a higher reported grade and falls back only when needed", async () => {
    await write({
      externalId: "published-beats-reported",
      climbedOn: "2026-09-01",
      discipline: "rock_climbing",
      climb: {
        externalId: "published-beats-reported-climb",
        name: "Published first",
        kind: "boulder",
        setting: "indoor",
        publishedGrades: [{ value: "V4", system: "v_scale" }],
      },
      reportedGrades: [{ value: "V10", system: "v_scale" }],
      attempts: [{ scope: "climb", qualifier: "free-onsight", sourceResult: "Onsight" }],
    });
    const fallback = await write(
      boulderOnsight(
        "reported-fallback",
        "2026-09-02",
        { value: "V6", system: "v_scale" },
        "outdoor",
        true,
      ),
    );

    const result = await repo().getBestOnsight(now);
    expect(result.rows[0].gym?.grade).toBe("V4");
    expect(result.rows[0].outdoor).toMatchObject({ grade: "V6", recordId: fallback });
  });

  it("skips unknown grade systems, falling back to a reported grade or leaving the cell empty", async () => {
    const fallback = await write({
      externalId: "unknown-published-reported-fallback",
      climbedOn: "2026-09-01",
      discipline: "rock_climbing",
      climb: {
        externalId: "unknown-published-reported-fallback-climb",
        name: "Unknown published, reported fallback",
        kind: "boulder",
        setting: "indoor",
        publishedGrades: [{ value: "mystery-grade", system: null }],
      },
      reportedGrades: [{ value: "V6", system: "v_scale" }],
      attempts: [{ scope: "climb", qualifier: "free-onsight", sourceResult: "Onsight" }],
    });
    await write({
      externalId: "fully-unrankable",
      climbedOn: "2026-09-02",
      discipline: "rock_climbing",
      climb: {
        externalId: "fully-unrankable-climb",
        name: "Fully unrankable",
        kind: "boulder",
        setting: "outdoor",
        publishedGrades: [{ value: "mystery-grade", system: null }],
      },
      reportedGrades: [{ value: "another-mystery-grade", system: null }],
      attempts: [{ scope: "climb", qualifier: "free-onsight", sourceResult: "Onsight" }],
    });

    const result = await repo().getBestOnsight(now);
    expect(result.rows[0].gym).toMatchObject({
      grade: "V6",
      gradeSystem: "v_scale",
      recordId: fallback,
    });
    expect(result.rows[0].outdoor).toBeNull();
  });

  it("ranks compatible grades across scales and breaks equal ranks by date and record id", async () => {
    expect(gradeSortValue("7a", "font")).toBe(72.5);
    expect(gradeSortValue("V6", "v_scale")).toBe(72);
    const fontId = await write(
      boulderOnsight("cross-scale-font", "2026-09-01", { value: "7a", system: "font" }),
    );
    await write(boulderOnsight("cross-scale-v", "2026-09-02", { value: "V6", system: "v_scale" }));

    const first = await repo().getBestOnsight(now);
    expect(first.rows[0].gym).toMatchObject({ grade: "7a", gradeSystem: "font", recordId: fontId });

    await context.db.execute(sql`DELETE FROM fitness.climbing_log_entry`);
    const tieOne = await write(
      boulderOnsight("tie-one", "2026-09-01", { value: "V5", system: "v_scale" }),
    );
    const tieTwo = await write(
      boulderOnsight("tie-two", "2026-09-01", { value: "V5", system: "v_scale" }),
    );
    const tie = await repo().getBestOnsight(now);
    expect(tie.rows[0].gym?.recordId).toBe([tieOne, tieTwo].sort()[0]);
  });
});
