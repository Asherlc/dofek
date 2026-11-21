import { randomUUID } from "node:crypto";
import { climbingDemonstratedGradeSchema } from "@dofek/training/climbing-demonstrated-grade";
import { DEFAULT_CLIMBING_GRADE_PREFERENCE } from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogEntries } from "../../../../src/db/climbing-log-sync.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ClimbingDemonstratedGradeRepository } from "./climbing-demonstrated-grade-repository.ts";

const FULL_ACCESS: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };

/** Real-database evidence selection against the correction-pass specification. */
describe("ClimbingDemonstratedGradeRepository database semantics", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const kayaProvider = "kaya";
  const mountainProjectProvider = "mountain-project";
  const openBetaProvider = "openbeta";
  const boardSeshProvider = "boardsesh";
  const mixedAProvider = `climb-mixed-a-${randomUUID()}`;
  const mixedBProvider = `climb-mixed-b-${randomUUID()}`;
  const anonymousProvider = `climb-anonymous-${randomUUID()}`;
  const angleProvider = `climb-angle-${randomUUID()}`;
  const attachmentProvider = `climb-attachment-${randomUUID()}`;
  const otherOwnerProvider = `climb-other-${randomUUID()}`;
  let context: TestContext;

  const repository = (accessWindow: AccessWindow = FULL_ACCESS, timezone = "UTC") =>
    new ClimbingDemonstratedGradeRepository(
      context.db,
      userId,
      timezone,
      accessWindow,
      DEFAULT_CLIMBING_GRADE_PREFERENCE,
    );

  async function insertActivity(input: {
    id: string;
    providerId: string;
    externalId: string;
    startedAt: string;
    userId?: string;
    offsetMinutes?: number | null;
    localTimeSource?: string | null;
    providerType?: string;
    deleted?: boolean;
  }) {
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source, deleted_at
      ) VALUES (
        ${input.id}::uuid, ${input.id}::uuid, ${input.providerId}, ${input.userId ?? userId}::uuid,
        ${input.externalId}, 'climbing', ${input.providerType ?? "bouldering"},
        ${input.startedAt}::timestamptz,
        ${input.startedAt}::timestamptz + INTERVAL '1 hour', 'Fixture', ${input.providerId},
        '{}'::jsonb, NULL, ${input.offsetMinutes ?? null}, ${input.offsetMinutes ?? null},
        ${input.localTimeSource ?? "unknown"}, ${input.deleted ? "2026-11-20T00:00:00Z" : null}
      )
    `);
  }

  function boardSeshTick(input: {
    boardType: string;
    climbUuid: string;
    mirror?: boolean;
    angle: number;
    consensusDifficulty: number | null;
    consensusDifficultyName: string | null;
    reportedDifficultyName?: string;
    reportedDifficulty?: number;
    withMetadata?: boolean;
  }) {
    const mirror = input.mirror ?? false;
    const externalId = `boardsesh:tick:${randomUUID()}`;
    const activityId = randomUUID();
    const climbExternalId = `${input.boardType}:${input.climbUuid}:${mirror ? "mirror" : "normal"}`;
    const ascent = {
      boardType: input.boardType,
      climbUuid: input.climbUuid,
      isMirror: mirror,
      angle: input.angle,
      consensusDifficulty: input.consensusDifficulty,
      consensusDifficultyName: input.consensusDifficultyName,
      boardseshDifficulty: input.reportedDifficulty ?? 99,
      boardseshConfidence: "untrusted_estimate",
    };
    const grades = [
      { difficultyId: 18, name: "6b/V4" },
      { difficultyId: 19, name: "6b+/V4" },
      { difficultyId: 20, name: "6c/V5" },
    ];
    return { externalId, activityId, climbExternalId, ascent, grades };
  }

  async function persistBoardSeshTick(
    tick: ReturnType<typeof boardSeshTick>,
    options: { deletedActivity?: boolean } = {},
  ) {
    await insertActivity({
      id: tick.activityId,
      providerId: boardSeshProvider,
      externalId: tick.externalId,
      startedAt: "2026-11-05T06:30:00Z",
      offsetMinutes: -420,
      localTimeSource: "provider_offset",
      providerType: "climbing_log",
      deleted: options.deletedActivity,
    });
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: boardSeshProvider,
      entries: [
        {
          externalId: tick.externalId,
          activityId: tick.activityId,
          discipline: "rock_climbing",
          wallAngle: { value: tick.ascent.angle, unit: "degrees" },
          reportedGrades: [{ value: "V9", system: "v_scale" }],
          raw: {
            climbedAt: "2026-11-05 06:30:00",
            metadata: { ascent: tick.ascent, grades: tick.grades },
          },
          climb: {
            externalId: tick.climbExternalId,
            kind: "boulder",
            name: tick.climbUuid,
            setting: "indoor",
          },
          attempts: [{ scope: "climb", qualifier: "free-flash", sourceResult: "flash" }],
        },
      ],
    });
  }

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES
        (${userId}::uuid, 'Demonstrated grade fixture'),
        (${otherUserId}::uuid, 'Other owner fixture')
    `);
    for (const [id, name, owner] of [
      [kayaProvider, "Kaya", userId],
      [mountainProjectProvider, "Mountain Project", userId],
      [openBetaProvider, "OpenBeta", userId],
      [boardSeshProvider, "BoardSesh", userId],
      [mixedAProvider, "Mixed A", userId],
      [mixedBProvider, "Mixed B", userId],
      [anonymousProvider, "Anonymous", userId],
      [angleProvider, "Angle", userId],
      [attachmentProvider, "Attachment", userId],
      [otherOwnerProvider, "Other owner", otherUserId],
    ] as const)
      await context.db.execute(sql`
        INSERT INTO fitness.provider (id, name, user_id) VALUES (${id}, ${name}, ${owner}::uuid)
      `);

    for (const [index, climbId] of ["v4-a", "v4-b", "v4-c"].entries()) {
      const activityId = randomUUID();
      await insertActivity({
        id: activityId,
        providerId: kayaProvider,
        externalId: `v4-session-${index}`,
        startedAt: `2026-11-1${index + 1}T18:00:00Z`,
      });
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: kayaProvider,
        entries: [
          {
            externalId: `v4-entry-${index}`,
            activityId,
            climbedOn: `2026-11-1${index + 1}`,
            discipline: "rock_climbing",
            raw: { climb: { slug: `v4-climb-${index}` } },
            climb: {
              externalId: climbId,
              kind: "boulder",
              name: `V4 climb ${index}`,
              setting: "indoor",
              areas: [{ externalId: "gym-wall", name: "Gym wall" }],
              publishedGrades: [{ value: "V4", system: "v_scale" }],
            },
            attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
          },
        ],
      });
    }
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("returns the eight-cell window with three verified sends and a verified source link", async () => {
    const result = climbingDemonstratedGradeSchema.parse(
      await repository().getDemonstratedGrade({ endDate: "2026-11-21" }),
    );
    expect(result).toMatchObject({ startDate: "2026-08-22", endDate: "2026-11-21" });
    expect(result.cells).toHaveLength(8);
    const grade = result.cells.find(
      (cell) => cell.type === "bouldering" && cell.setting === "indoor",
    )?.grades[0];
    expect(grade).toEqual(expect.objectContaining({ grade: "V4", count: 3 }));
    expect(grade?.sends.every((send) => send.ropeMethod === null)).toBe(true);
    expect(
      grade?.sends.some((send) =>
        send.sourceUrl?.startsWith("https://kaya-app.kayaclimb.com/climb/"),
      ),
    ).toBe(true);
  });

  it.each([
    ["Gym wall", "v_scale", ["V4"]],
    ["Different gym", "v_scale", []],
    ["Gym wall", "font", []],
  ] as const)("filters qualifying evidence by %s and %s", async (location, system, grades) => {
    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [kayaProvider],
      locations: [location],
      gradeSystems: [system],
    });
    const cell = result.cells.find(
      ({ type, setting }) => type === "bouldering" && setting === "indoor",
    );
    expect(cell?.grades.map(({ grade }) => grade)).toEqual(grades);
  });

  it("qualifies an inclusive window start and skips a pitch-only query", async () => {
    const atStart = await repository().getDemonstratedGrade({ endDate: "2026-11-21" });
    expect(atStart.startDate).toBe("2026-08-22");
    const pitchOnly = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      filters: { attemptScope: ["pitch"] },
    });
    expect(pitchOnly.cells.every((cell) => cell.grades.length === 0)).toBe(true);
  });

  it("excludes anonymous climbs without a native source ID", async () => {
    for (const index of [1, 2, 3]) {
      const activityId = randomUUID();
      await insertActivity({
        id: activityId,
        providerId: anonymousProvider,
        externalId: `anonymous-session-${index}`,
        startedAt: `2026-11-0${index}T18:00:00Z`,
      });
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: anonymousProvider,
        entries: [
          {
            externalId: `anonymous-entry-${index}`,
            activityId,
            climbedOn: `2026-11-0${index}`,
            discipline: "rock_climbing",
            climb: {
              externalId: `anonymous-temp-${index}`,
              kind: "boulder",
              name: `Anonymous ${index}`,
              setting: "indoor",
              publishedGrades: [{ value: "V8", system: "v_scale" }],
            },
            attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
          },
        ],
      });
    }
    // The sync input requires a source ID; clear it to model a record-local climb.
    await context.db.execute(sql`
      UPDATE fitness.climb SET external_id = NULL
      WHERE user_id = ${userId}::uuid AND external_id LIKE 'anonymous-temp-%'
    `);
    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [anonymousProvider],
    });
    expect(result.cells.every((cell) => cell.grades.length === 0)).toBe(true);
  });

  it("never adds two climbs from one source to one from another", async () => {
    for (const [index, climbId] of ["mixed-1", "mixed-2"].entries()) {
      const activityId = randomUUID();
      await insertActivity({
        id: activityId,
        providerId: mixedAProvider,
        externalId: `mixed-session-${index}`,
        startedAt: `2026-11-0${index + 4}T18:00:00Z`,
      });
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: mixedAProvider,
        entries: [
          {
            externalId: `mixed-entry-${index}`,
            activityId,
            climbedOn: `2026-11-0${index + 4}`,
            discipline: "rock_climbing",
            climb: {
              externalId: climbId,
              kind: "boulder",
              name: `Mixed ${index}`,
              setting: "indoor",
              publishedGrades: [{ value: "V9", system: "v_scale" }],
            },
            attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
          },
        ],
      });
    }
    const splitActivity = randomUUID();
    await insertActivity({
      id: splitActivity,
      providerId: mixedBProvider,
      externalId: "mixed-second-session",
      startedAt: "2026-11-07T18:00:00Z",
    });
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: mixedBProvider,
      entries: [
        {
          externalId: "mixed-second-entry",
          activityId: splitActivity,
          climbedOn: "2026-11-07",
          discipline: "rock_climbing",
          climb: {
            externalId: "mixed-3",
            kind: "boulder",
            name: "Mixed other source",
            setting: "indoor",
            publishedGrades: [{ value: "V9", system: "v_scale" }],
          },
          attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
        },
      ],
    });

    const sources = [mixedAProvider, mixedBProvider];
    const split = await repository().getDemonstratedGrade({ endDate: "2026-11-21", sources });
    expect(
      split.cells.find((cell) => cell.type === "bouldering" && cell.setting === "indoor")?.grades,
    ).toEqual([]);

    const thirdActivity = randomUUID();
    await insertActivity({
      id: thirdActivity,
      providerId: mixedAProvider,
      externalId: "mixed-third-session",
      startedAt: "2026-11-08T18:00:00Z",
    });
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: mixedAProvider,
      entries: [
        {
          externalId: "mixed-third-entry",
          activityId: thirdActivity,
          climbedOn: "2026-11-08",
          discipline: "rock_climbing",
          climb: {
            externalId: "mixed-4",
            kind: "boulder",
            name: "Mixed third",
            setting: "indoor",
            publishedGrades: [{ value: "V9", system: "v_scale" }],
          },
          attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
        },
      ],
    });
    const verified = await repository().getDemonstratedGrade({ endDate: "2026-11-21", sources });
    expect(
      verified.cells.find((cell) => cell.type === "bouldering" && cell.setting === "indoor")
        ?.grades[0].count,
    ).toBe(3);
  });

  it("uses exact BoardSesh consensus evidence and the exact dated observation", async () => {
    for (const uuid of ["problem-a", "problem-b", "problem-c"])
      await persistBoardSeshTick(
        boardSeshTick({
          boardType: "kilter",
          climbUuid: uuid,
          angle: 30,
          consensusDifficulty: 18,
          consensusDifficultyName: "6b/V4",
          reportedDifficulty: 25,
          reportedDifficultyName: "V10",
        }),
      );

    const result = await repository(undefined, "America/Los_Angeles").getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [boardSeshProvider],
    });
    const grade = result.cells.find(
      (cell) => cell.type === "bouldering" && cell.setting === "indoor",
    )?.grades[0];
    expect(grade).toEqual(
      expect.objectContaining({
        grade: "6b",
        gradeSystem: "font",
        publishedLabel: "6b/V4",
        count: 3,
      }),
    );
    expect(grade?.sends.every((send) => send.climbedOn === "2026-11-04")).toBe(true);
    expect(grade?.sends.every((send) => send.climbExternalId?.startsWith("kilter:"))).toBe(true);
  });

  it("rejects reported/model grades without consensus and never merges coarse V labels", async () => {
    for (const uuid of ["model-a", "model-b", "model-c"])
      await persistBoardSeshTick(
        boardSeshTick({
          boardType: "tension",
          climbUuid: uuid,
          angle: 25,
          consensusDifficulty: null,
          consensusDifficultyName: null,
          reportedDifficulty: 22,
        }),
      );
    const withoutConsensus = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [boardSeshProvider],
    });
    // The kilter consensus fixture still qualifies; the tension rows do not add evidence.
    const tensionSends = withoutConsensus.cells
      .flatMap((cell) => cell.grades)
      .flatMap((grade) => grade.sends)
      .filter((send) => send.climbExternalId?.startsWith("tension:"));
    expect(tensionSends).toEqual([]);

    for (const [uuid, difficulty, name] of [
      ["coarse-a", 18, "6b/V4"],
      ["coarse-b", 18, "6b/V4"],
      ["coarse-c", 19, "6b+/V4"],
    ] as const)
      await persistBoardSeshTick(
        boardSeshTick({
          boardType: "moonboard",
          climbUuid: uuid,
          angle: 40,
          consensusDifficulty: difficulty,
          consensusDifficultyName: name,
        }),
      );
    const coarse = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [boardSeshProvider],
    });
    const coarseSends = coarse.cells
      .flatMap((cell) => cell.grades)
      .flatMap((grade) => grade.sends)
      .filter((send) => send.climbExternalId?.startsWith("moonboard:"));
    expect(coarseSends).toEqual([]);
  });

  it("collapses board angle and mirror states into one native problem", async () => {
    for (const [index, mirror] of [false, true].entries())
      await persistBoardSeshTick(
        boardSeshTick({
          boardType: "kilter",
          climbUuid: "shared-problem",
          mirror,
          angle: index === 0 ? 0 : 40,
          consensusDifficulty: 18,
          consensusDifficultyName: "6b/V4",
        }),
      );
    await persistBoardSeshTick(
      boardSeshTick({
        boardType: "kilter",
        climbUuid: "other-problem",
        angle: 25,
        consensusDifficulty: 18,
        consensusDifficultyName: "6b/V4",
      }),
    );
    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [boardSeshProvider],
    });
    const sends = result.cells
      .flatMap((cell) => cell.grades)
      .flatMap((grade) => grade.sends)
      .filter((send) => send.climbExternalId?.startsWith("kilter:shared-problem"));
    expect(new Set(sends.map((send) => send.logEntryId)).size).toBeLessThanOrEqual(1);
  });

  it("does not date an undated tick from a deleted observation", async () => {
    const tick = boardSeshTick({
      boardType: "kilter",
      climbUuid: "deleted-observation",
      angle: 30,
      consensusDifficulty: 18,
      consensusDifficultyName: "6b/V4",
    });
    await persistBoardSeshTick(tick, { deletedActivity: true });
    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [boardSeshProvider],
    });
    const sends = result.cells
      .flatMap((cell) => cell.grades)
      .flatMap((grade) => grade.sends)
      .filter(
        (send) =>
          send.logEntryId === tick.externalId || send.climbExternalId === tick.climbExternalId,
      );
    expect(sends).toEqual([]);
  });

  it("keeps blank compatibility completions and other owners out", async () => {
    const activityId = randomUUID();
    await insertActivity({
      id: activityId,
      providerId: mountainProjectProvider,
      externalId: "mp-blank-tr",
      startedAt: "2026-11-05T18:00:00Z",
    });
    const mpEntry = (index: number) => ({
      externalId: `mp-blank-tr-entry-${index}`,
      activityId,
      climbedOn: "2026-11-05",
      discipline: "rock_climbing" as const,
      climb: {
        externalId: `mp-route-${index}`,
        kind: "route" as const,
        name: `Blank top rope ${index}`,
        setting: "outdoor" as const,
        publishedGrades: [{ value: "5.11a", system: "yds" as const }],
      },
      attempts: [
        {
          scope: "climb" as const,
          ropeMethod: "top_rope" as const,
          sourceCompleted: null,
          sourceResult: null,
        },
      ],
    });
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: mountainProjectProvider,
      entries: [mpEntry(1), mpEntry(2), mpEntry(3)],
    });
    const result = await repository().getDemonstratedGrade({ endDate: "2026-11-21" });
    expect(
      result.cells.find((cell) => cell.type === "top_rope" && cell.setting === "outdoor")?.grades,
    ).toEqual([]);
  });

  it("does not inherit a date from an attachment-only session", async () => {
    for (const index of [1, 2, 3]) {
      const activityId = randomUUID();
      await insertActivity({
        id: activityId,
        providerId: attachmentProvider,
        externalId: `session-${index}`,
        startedAt: "2026-11-09T18:00:00Z",
        providerType: "bouldering",
      });
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: attachmentProvider,
        entries: [
          {
            externalId: `attach-entry-${index}`,
            activityId,
            discipline: "rock_climbing",
            climb: {
              externalId: `attach-climb-${index}`,
              kind: "boulder",
              name: `Attached climb ${index}`,
              setting: "indoor",
              publishedGrades: [{ value: "V7", system: "v_scale" }],
            },
            attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
          },
        ],
      });
    }
    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [attachmentProvider],
    });
    expect(result.cells.every((cell) => cell.grades.length === 0)).toBe(true);
  });

  it("normalizes a scalar Follow selection to the pooled Top rope cohort", async () => {
    const methods = ["top_rope", "top_rope", "follow"] as const;
    for (const [index, method] of methods.entries()) {
      const activityId = randomUUID();
      await insertActivity({
        id: activityId,
        providerId: kayaProvider,
        externalId: `scalar-tr-session-${index}`,
        startedAt: `2026-10-2${index}T18:00:00Z`,
      });
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: kayaProvider,
        entries: [
          {
            externalId: `scalar-tr-entry-${index}`,
            activityId,
            climbedOn: `2026-10-2${index}`,
            discipline: "rock_climbing",
            climb: {
              externalId: `scalar-route-${index}`,
              kind: "route",
              name: `Scalar route ${index}`,
              setting: "outdoor",
              publishedGrades: [{ value: "5.10a", system: "yds" }],
            },
            attempts: [
              {
                scope: "climb",
                ropeMethod: method,
                qualifier: "free-send",
                sourceResult: "Send",
              },
            ],
          },
        ],
      });
    }
    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      filters: { ropeMethod: "follow" },
    });
    const grade = result.cells.find(
      (cell) => cell.type === "top_rope" && cell.setting === "outdoor",
    )?.grades[0];
    expect(grade).toEqual(expect.objectContaining({ grade: "5.10a", count: 3 }));
    expect(grade?.sends.map((send) => send.ropeMethod).sort()).toEqual([
      "follow",
      "top_rope",
      "top_rope",
    ]);

    // Scalar selection first: an intersecting type array still only admits the
    // pooled Top rope cohort, and an unrelated type excludes everything.
    const intersecting = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      filters: { ropeMethod: "follow", types: ["lead", "follow"] },
    });
    expect(
      intersecting.cells.find((cell) => cell.type === "top_rope" && cell.setting === "outdoor")
        ?.grades[0].count,
    ).toBe(3);
    expect(
      intersecting.cells.find((cell) => cell.type === "lead" && cell.setting === "outdoor")?.grades,
    ).toEqual([]);

    const unrelated = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      filters: { ropeMethod: "follow", types: ["lead"] },
    });
    expect(unrelated.cells.every((cell) => cell.grades.length === 0)).toBe(true);
  });

  it("requires an active owned attachment while keeping standalone dated logs eligible", async () => {
    const absentActivity = randomUUID();
    await insertActivity({
      id: absentActivity,
      providerId: kayaProvider,
      externalId: "absent-attachment-session",
      startedAt: "2026-11-10T18:00:00Z",
    });
    await context.db.execute(sql`
      UPDATE fitness.activity SET provider_absent_at = NOW() WHERE id = ${absentActivity}::uuid
    `);
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: kayaProvider,
      entries: [
        {
          externalId: "absent-attachment-entry",
          activityId: absentActivity,
          climbedOn: "2026-11-10",
          discipline: "rock_climbing",
          climb: {
            externalId: "absent-attachment-climb",
            kind: "boulder",
            name: "Absent attachment",
            setting: "indoor",
            publishedGrades: [{ value: "V6", system: "v_scale" }],
          },
          attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
        },
      ],
    });

    for (const index of [1, 2, 3]) {
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: kayaProvider,
        entries: [
          {
            externalId: `standalone-dated-${index}`,
            climbedOn: `2026-11-0${index}`,
            discipline: "rock_climbing",
            climb: {
              externalId: `standalone-climb-${index}`,
              kind: "boulder",
              name: `Standalone ${index}`,
              setting: "indoor",
              publishedGrades: [{ value: "V6", system: "v_scale" }],
            },
            attempts: [{ scope: "climb", qualifier: "free-send", sourceResult: "Send" }],
          },
        ],
      });
    }

    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [kayaProvider],
    });
    const grade = result.cells.find(
      (cell) => cell.type === "bouldering" && cell.setting === "indoor",
    )?.grades;
    // The higher V6 cohort is supported only by the three standalone dated logs.
    expect(grade?.map((entry) => [entry.grade, entry.count])).toEqual([["V6", 3]]);
    expect(
      grade?.some((entry) =>
        entry.sends.some((send) => send.climbExternalId === "absent-attachment-climb"),
      ),
    ).toBe(false);
  });

  it("does not pool a top-rope grade from a log-level OpenBeta attemptType on a multi-attempt log", async () => {
    for (const index of [1, 2, 3]) {
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: openBetaProvider,
        entries: [
          {
            externalId: `ob-multi-entry-${index}`,
            climbedOn: `2026-11-0${index}`,
            discipline: "rock_climbing",
            raw: { attemptType: "Redpoint" },
            climb: {
              externalId: `ob-multi-route-${index}`,
              kind: "route",
              name: `OpenBeta multi route ${index}`,
              setting: "outdoor",
              publishedGrades: [{ value: "5.10a", system: "yds" }],
            },
            attempts: [
              {
                scope: "climb",
                qualifier: "free-send",
                ropeMethod: "lead",
                sourceResult: "Redpoint",
              },
              { scope: "climb", qualifier: "free-send", ropeMethod: "top_rope" },
            ],
          },
        ],
      });
    }

    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [openBetaProvider],
    });
    // The log-level "Redpoint" cannot be borrowed by the unlabeled top-rope try.
    expect(
      result.cells.find((cell) => cell.type === "top_rope" && cell.setting === "outdoor")?.grades,
    ).toEqual([]);
    // The lead try keeps its own explicit source_result on the same multi-attempt log.
    expect(
      result.cells.find((cell) => cell.type === "lead" && cell.setting === "outdoor")?.grades[0],
    ).toEqual(expect.objectContaining({ grade: "5.10a", count: 3 }));
  });

  it("qualifies legacy OpenBeta results attributable to one attempt per climb", async () => {
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: openBetaProvider,
      entries: [1, 2, 3].map((index) => ({
        externalId: `ob-single-entry-${index}`,
        climbedOn: "2026-11-06",
        discipline: "rock_climbing",
        raw: { attemptType: "Redpoint" },
        climb: {
          externalId: `ob-single-route-${index}`,
          kind: "route",
          name: `OpenBeta single legacy route ${index}`,
          setting: "outdoor",
          publishedGrades: [{ value: "5.9", system: "yds" }],
        },
        attempts: [{ scope: "climb", qualifier: "free-send", ropeMethod: "top_rope" }],
      })),
    });

    const result = await repository().getDemonstratedGrade({
      endDate: "2026-11-21",
      sources: [openBetaProvider],
    });
    expect(
      result.cells.find((cell) => cell.type === "top_rope" && cell.setting === "outdoor")?.grades,
    ).toEqual([expect.objectContaining({ grade: "5.9", count: 3 })]);
  });

  it("reports partial coverage only when access does not cover the whole window", async () => {
    const historical = await repository({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-08-01",
      endDateExclusive: "2026-12-01",
    }).getDemonstratedGrade({ endDate: "2026-11-21" });
    expect(historical.coverage.fullWindow).toBe(true);

    const restricted = await repository({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-10-01",
      endDateExclusive: "2026-11-22",
    }).getDemonstratedGrade({ endDate: "2026-11-21" });
    expect(restricted.coverage).toEqual({
      fullWindow: false,
      startDate: "2026-10-01",
      endDate: "2026-11-21",
    });

    const disjoint = await repository({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2027-01-01",
      endDateExclusive: "2027-02-01",
    }).getDemonstratedGrade({ endDate: "2026-11-21" });
    expect(disjoint.coverage).toEqual({
      fullWindow: false,
      startDate: null,
      endDate: null,
    });
  });
});
