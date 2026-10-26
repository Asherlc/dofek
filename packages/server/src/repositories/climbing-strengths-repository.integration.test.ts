import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SourceClimbingLogEntry } from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climb, climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { buildClimbingStrengths } from "../services/climbing-strengths.ts";
import {
  climbingTestDate,
  seedClimbingActivity,
  seedClimbingLog,
} from "./climbing-integration-test-helpers.ts";
import { ClimbingStrengthsRepository } from "./climbing-strengths-repository.ts";

describe("climbing strengths PostgreSQL", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    for (const id of ["mountain-project", "openbeta"])
      await ensureProvider(context.db, id, id, undefined, TEST_USER_ID);
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity);
  });
  afterAll(async () => context.cleanup());
  const repo = () => new ClimbingStrengthsRepository(context.db, TEST_USER_ID, "UTC");
  const write = async (
    externalId: string,
    patch: Partial<SourceClimbingLogEntry> = {},
    provider = "mountain-project",
  ) =>
    seedClimbingLog(context.db, provider, {
      externalId,
      climbedOn: await climbingTestDate(context.db),
      discipline: "rock_climbing",
      climb: {
        externalId: "climb",
        name: "Corner",
        kind: "route",
        setting: "outdoor",
        publishedGrades: [{ value: "5.10a", system: "yds" }],
        areas: [{ externalId: "wall", name: "Wall" }],
      },
      attempts: [
        { scope: "climb", ropeMethod: "lead", sourceResult: "Send", qualifier: "free-send" },
      ],
      ...patch,
    });
  it("uses canonical outcome facts and counts repeated and cross-provider climbs once", async () => {
    await write("send");
    await write("repeat");
    await write("duplicate", {}, "openbeta");
    const failureId = await write("failure", {
      climb: {
        externalId: "project",
        name: "Project",
        kind: "route",
        setting: "outdoor",
        publishedGrades: [{ value: "5.10a", system: "yds" }],
        areas: [{ externalId: "wall", name: "Wall" }],
      },
      attempts: [{ scope: "climb", ropeMethod: "lead", sourceResult: "Failed", usedAid: false }],
    });
    const observations = await repo().getObservations(30);
    expect(observations.find((entry) => entry.example.logEntryId === failureId)?.outcome).toBe(
      "not_sent",
    );
    const result = buildClimbingStrengths(observations);
    expect(
      result.panels.find((p) => p.dimension === "setting" && p.grades.some((g) => g.sends > 0))
        ?.grades[0],
    ).toMatchObject({ climbs: 2, sends: 1, successRate: 50 });
  });
  it("preserves unknown outcomes and unknown angle units", async () => {
    await write("unknown", {
      wallAngle: { value: 30, unit: null },
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
    });
    const result = buildClimbingStrengths(await repo().getObservations(30));
    expect(result.coverage.unknownOutcomes).toBe(1);
    expect(result.panels.every((p) => p.grades.length === 0)).toBe(true);
  });
  it("filters dates, settings, access windows and deleted attached activity", async () => {
    const old = await write("old", { climbedOn: await climbingTestDate(context.db, 40) });
    const visible = await write("visible");
    const outing = await seedClimbingActivity(context.db, "mountain-project", "outing");
    await write("attached", { activityId: outing.id });
    expect((await repo().getObservations(30)).map((e) => e.example.logEntryId)).toContain(visible);
    expect((await repo().getObservations(30)).map((e) => e.example.logEntryId)).not.toContain(old);
    expect(await repo().getObservations(30, { setting: "indoor" })).toEqual([]);
    await context.db
      .update(activity)
      .set({ deletedAt: new Date() })
      .where(eq(activity.id, outing.id));
    expect((await repo().getObservations(30)).every((e) => e.example.activityId === null)).toBe(
      true,
    );
    const startDate = await climbingTestDate(context.db, 1);
    const endDateExclusive = await climbingTestDate(context.db, 0);
    expect(
      await new ClimbingStrengthsRepository(context.db, TEST_USER_ID, "UTC", {
        kind: "limited",
        startDate,
        endDateExclusive,
        paid: false,
        reason: "free_recent_week",
      }).getObservations(30),
    ).toEqual([]);
    expect(
      await new ClimbingStrengthsRepository(
        context.db,
        "00000000-0000-0000-0000-000000000099",
        "UTC",
      ).getObservations(30),
    ).toEqual([]);
  });
  it("retains supplementary canonical traits from a second source for the same attached climb", async () => {
    const outing = await seedClimbingActivity(context.db, "mountain-project", "trait-outing");
    await write("first", { activityId: outing.id });
    await write("second", { activityId: outing.id, holdType: "crimp" }, "openbeta");
    const result = buildClimbingStrengths(await repo().getObservations(30));
    expect(
      result.panels.find((panel) => panel.dimension === "hold_type")?.rows[0]?.cells[0],
    ).toMatchObject({ climbs: 1, sends: 1 });
  });
  it("excludes one cross-provider identified climb with conflicting recognized grades", async () => {
    const catalogue = {
      externalId: "conflict",
      name: "Conflicting problem",
      kind: "boulder",
      setting: "outdoor",
      areas: [{ externalId: "wall", name: "Wall" }],
    } as const;
    const failureId = await write("v4-failure", {
      climb: { ...catalogue, publishedGrades: [{ value: "V4", system: "v_scale" }] },
      attempts: [{ scope: "climb", usedAid: false, sourceResult: "Failed" }],
    });
    await write(
      "v5-send",
      {
        climb: { ...catalogue, publishedGrades: [{ value: "V5", system: "v_scale" }] },
        attempts: [{ scope: "climb", sourceResult: "Send", qualifier: "free-send" }],
      },
      "openbeta",
    );
    const observations = await repo().getObservations(30);
    expect(observations.find((entry) => entry.example.logEntryId === failureId)?.outcome).toBe(
      "not_sent",
    );
    const result = buildClimbingStrengths(observations);
    expect(result.coverage.missingGrades).toBe(2);
    expect(result.panels).toEqual([]);
  });
  it("merges a send with a missing grade into the unique known grade-system lane", async () => {
    const failureId = await write("graded", {
      attempts: [{ scope: "climb", ropeMethod: "lead", usedAid: false, sourceResult: "Failed" }],
    });
    await write(
      "missingGrade",
      {
        climb: {
          externalId: "climb",
          name: "Corner",
          kind: "route",
          setting: "outdoor",
          publishedGrades: [],
          areas: [{ externalId: "wall", name: "Wall" }],
        },
      },
      "openbeta",
    );
    const observations = await repo().getObservations(30);
    expect(observations.find((entry) => entry.example.logEntryId === failureId)?.outcome).toBe(
      "not_sent",
    );
    expect(observations.some((entry) => entry.grade === null && entry.outcome === "sent")).toBe(
      true,
    );
    const result = buildClimbingStrengths(observations);
    expect(result.coverage.missingGrades).toBe(0);
    expect(result.panels.find((panel) => panel.dimension === "setting")?.grades).toMatchObject([
      { climbs: 1, sends: 1, successRate: 100 },
    ]);
  });
  it("anchors a one-day historic window with exclusive lower and inclusive end dates", async () => {
    await write("before", { climbedOn: "2025-02-04" });
    const included = await write("included", { climbedOn: "2025-02-05" });
    await write("after", { climbedOn: "2025-02-06" });
    expect(
      (await repo().getObservations(1, {}, "2025-02-05")).map((entry) => entry.example.logEntryId),
    ).toEqual([included]);
  });
});
