import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SourceClimbingLogEntry } from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climb, climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import {
  buildClimbingStrengths,
  type ClimbingStrengthsObservation,
} from "../services/climbing-strengths.ts";
import {
  climbingTestDate,
  seedClimbingActivity,
  seedClimbingLog,
} from "./climbing-integration-test-helpers.ts";
import { ClimbingStrengthsRepository } from "./climbing-strengths-repository.ts";

describe("climbing strengths PostgreSQL", () => {
  let context: TestContext;
  let window: { startDate: string; endDate: string };
  const analyze = (observations: ClimbingStrengthsObservation[]) =>
    buildClimbingStrengths(observations, window);
  beforeAll(async () => {
    context = await setupTestDatabase();
    window = {
      startDate: await climbingTestDate(context.db, 29),
      endDate: await climbingTestDate(context.db, 0),
    };
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
  it("serves multiple grips and categorical angles without duplicating baseline climbs", async () => {
    const originalId = await write("multi", {
      holdTypes: ["crimp", "jam"],
      wallAngle: { category: "overhang" },
    });
    const repeatId = await write("repeat", {
      holdTypes: ["jam", "crimp"],
      wallAngle: { category: "overhang" },
    });
    const observations = await repo().getObservations(30);
    expect(observations.find((entry) => entry.example.logEntryId === originalId)).toMatchObject({
      holdTypes: ["crimp", "jam"],
      wallAngle: { category: "overhang" },
    });
    expect(observations.find((entry) => entry.example.logEntryId === repeatId)).toMatchObject({
      holdTypes: ["jam", "crimp"],
      wallAngle: { category: "overhang" },
    });
    const result = analyze(observations);
    const holds = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(holds?.grades[0]?.climbs).toBe(1);
    expect(holds?.rows.map((row) => [row.key, row.cells[0]?.climbs])).toEqual([
      ["crimp", 1],
      ["jam", 1],
    ]);
    expect(result.panels.find((panel) => panel.dimension === "wall_angle")?.rows[0]?.key).toBe(
      "overhang",
    );
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
    const result = analyze(observations);
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
    const result = analyze(await repo().getObservations(30));
    expect(result.coverage.unknownOutcomes).toBe(1);
    expect(result.panels.every((panel) => panel.grades.length === 1)).toBe(true);
    const setting = result.panels.find((panel) => panel.dimension === "setting");
    expect(setting?.grades[0]).toMatchObject({
      grade: "5.10a",
      climbs: 1,
      unknownOutcomes: 1,
      successRate: null,
    });
    expect(setting?.rows[1]?.cells[0]?.examples[0]?.outcome).toBeNull();
  });
  it.each([
    {
      provider: "mountain-project",
      sends: 1,
      unknownOutcomes: 0,
      successRate: 100,
      outcome: "sent",
    },
    { provider: "openbeta", sends: 1, unknownOutcomes: 0, successRate: 100, outcome: "sent" },
  ])(
    "retains top-rope grades with the recorded $provider result semantics",
    async ({ provider, sends, unknownOutcomes, successRate, outcome }) => {
      for (const grade of ["5.2", "5.9", "5.10b"]) {
        await write(
          `top-rope-${grade}`,
          {
            climb: {
              externalId: `route-${grade}`,
              name: `Route ${grade}`,
              kind: "route",
              publishedGrades: [{ value: grade, system: "yds" }],
            },
            attempts: [{ scope: "climb", ropeMethod: "top_rope" }],
          },
          provider,
        );
      }
      const observations = await repo().getObservations(30);
      expect(observations).toHaveLength(3);
      expect(observations.every((entry) => entry.setting === "outdoor")).toBe(true);
      const result = analyze(observations);
      const setting = result.panels.find((panel) => panel.dimension === "setting");
      expect(setting?.contextLabel).toBe("Top rope");
      expect(setting?.grades).toMatchObject(
        ["5.2", "5.9", "5.10b"].map((grade) => ({
          grade,
          climbs: 1,
          sends,
          unknownOutcomes,
          successRate,
        })),
      );
      expect(setting?.rows.find((row) => row.key === "outdoor")?.cells).toMatchObject([
        { climbs: 1, unknownOutcomes, successRate, examples: [{ outcome }] },
        { climbs: 1, unknownOutcomes, successRate, examples: [{ outcome }] },
        { climbs: 1, unknownOutcomes, successRate, examples: [{ outcome }] },
      ]);
    },
  );
  it("queries all accessible history through the selected end date", async () => {
    const old = await write("historical", { climbedOn: await climbingTestDate(context.db, 800) });
    const recent = await write("recent");
    const future = await write("future", { climbedOn: await climbingTestDate(context.db, -1) });
    const historical = await repo().getObservations(null, {}, window.endDate);
    expect(historical.map((entry) => entry.example.logEntryId)).toEqual(
      expect.arrayContaining([old, recent]),
    );
    expect(historical.some((entry) => entry.example.logEntryId === future)).toBe(false);
    expect(
      (await repo().getObservations(365, {}, window.endDate)).some(
        (entry) => entry.example.logEntryId === old,
      ),
    ).toBe(false);
    const restricted = new ClimbingStrengthsRepository(context.db, TEST_USER_ID, "UTC", {
      kind: "limited",
      startDate: window.startDate,
      endDateExclusive: await climbingTestDate(context.db, -1),
      paid: false,
      reason: "free_recent_week",
    });
    expect(
      (await restricted.getObservations(null, {}, window.endDate)).map(
        (entry) => entry.example.logEntryId,
      ),
    ).toEqual([recent]);
    expect(
      await new ClimbingStrengthsRepository(
        context.db,
        "00000000-0000-0000-0000-000000000099",
        "UTC",
      ).getObservations(null, {}, window.endDate),
    ).toEqual([]);
  });
  it("treats omitted aid use as free and keeps explicit aid separate", async () => {
    const unspecified = await write("unspecified", {
      attempts: [{ scope: "climb", ropeMethod: "lead", sourceResult: "Failed" }],
    });
    const free = await write("free", {
      attempts: [{ scope: "climb", ropeMethod: "lead", sourceResult: "Failed", usedAid: false }],
    });
    const aid = await write("aid", {
      attempts: [{ scope: "climb", ropeMethod: "lead", sourceResult: "Failed", usedAid: true }],
    });
    const rows = await repo().getObservations(30);
    const contextFor = (id: string) =>
      rows.find((entry) => entry.example.logEntryId === id)?.contextKey;
    expect(contextFor(unspecified)).toBe(contextFor(free));
    expect(contextFor(aid)).not.toBe(contextFor(free));
    expect(rows.find((entry) => entry.example.logEntryId === free)?.contextLabel).toBe(
      "Lead · Yosemite Decimal System",
    );
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
    await write("second", { activityId: outing.id, holdTypes: ["crimp"] }, "openbeta");
    const result = analyze(await repo().getObservations(30));
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
    const result = analyze(observations);
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
    const result = analyze(observations);
    expect(result.coverage.missingGrades).toBe(0);
    expect(result.panels.find((panel) => panel.dimension === "setting")?.grades).toMatchObject([
      { climbs: 1, sends: 1, successRate: 100 },
    ]);
  });
  it("projects cross-month original outcomes after resolving missing source grades and zero-angle traits", async () => {
    await write("august-failure", {
      climbedOn: "2026-08-15",
      holdTypes: ["crimp"],
      wallAngle: { value: 0, unit: "degrees" },
      attempts: [{ scope: "climb", ropeMethod: "lead", usedAid: false, sourceResult: "Failed" }],
    });
    await write(
      "september-send",
      {
        climbedOn: "2026-09-01",
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
    await write("october-unknown", {
      climbedOn: "2026-10-20",
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
    });
    const observations = await repo().getObservations(67, {}, "2026-10-20");
    expect(observations).toHaveLength(3);
    const result = buildClimbingStrengths(observations, {
      startDate: "2026-08-15",
      endDate: "2026-10-20",
    });
    const panel = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.rows[0]?.cells[0]).toMatchObject({
      sends: 1,
      climbs: 1,
      unknownOutcomes: 0,
      successRate: 100,
    });
    expect(panel?.progress).toEqual([
      {
        startDate: "2026-08-15",
        endDate: "2026-08-31",
        rows: [
          {
            key: "crimp",
            cells: [
              {
                grade: "5.10a",
                sends: 0,
                climbs: 1,
                unknownOutcomes: 0,
                successRate: 0,
                sampleStatus: "limited",
              },
            ],
          },
        ],
      },
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        rows: [
          {
            key: "crimp",
            cells: [
              {
                grade: "5.10a",
                sends: 1,
                climbs: 1,
                unknownOutcomes: 0,
                successRate: 100,
                sampleStatus: "limited",
              },
            ],
          },
        ],
      },
      {
        startDate: "2026-10-01",
        endDate: "2026-10-20",
        rows: [
          {
            key: "crimp",
            cells: [
              {
                grade: "5.10a",
                sends: 0,
                climbs: 1,
                unknownOutcomes: 1,
                successRate: null,
                sampleStatus: "limited",
              },
            ],
          },
        ],
      },
    ]);
    expect(
      result.panels.find((panel) => panel.dimension === "wall_angle")?.progress[1]?.rows[0],
    ).toMatchObject({ key: "0°", cells: [{ sends: 1, climbs: 1 }] });
  });
  it("does not resurrect cross-month conflicting grades in otherwise valid monthly panels", async () => {
    const catalogue = {
      externalId: "conflict",
      name: "Conflict",
      kind: "route",
      setting: "outdoor",
      areas: [{ externalId: "wall", name: "Wall" }],
    } as const;
    await write("conflict-august", {
      climbedOn: "2026-08-20",
      climb: { ...catalogue, publishedGrades: [{ value: "5.10a", system: "yds" }] },
    });
    await write(
      "conflict-september",
      {
        climbedOn: "2026-09-20",
        climb: { ...catalogue, publishedGrades: [{ value: "5.11a", system: "yds" }] },
      },
      "openbeta",
    );
    await write("retained", { climbedOn: "2026-10-20" });
    const result = buildClimbingStrengths(await repo().getObservations(67, {}, "2026-10-20"), {
      startDate: "2026-08-15",
      endDate: "2026-10-20",
    });
    expect(result.coverage.missingGrades).toBe(2);
    const panel = result.panels.find((panel) => panel.dimension === "setting");
    expect(panel?.progress[0]?.rows[1]?.cells).toEqual([
      {
        grade: "5.10a",
        sends: 0,
        climbs: 0,
        unknownOutcomes: 0,
        successRate: null,
        sampleStatus: "no_data",
      },
    ]);
    expect(panel?.progress[1]?.rows[1]?.cells).toEqual([
      {
        grade: "5.10a",
        sends: 0,
        climbs: 0,
        unknownOutcomes: 0,
        successRate: null,
        sampleStatus: "no_data",
      },
    ]);
    expect(panel?.progress[2]?.rows[1]?.cells).toEqual([
      {
        grade: "5.10a",
        sends: 1,
        climbs: 1,
        unknownOutcomes: 0,
        successRate: 100,
        sampleStatus: "limited",
      },
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
