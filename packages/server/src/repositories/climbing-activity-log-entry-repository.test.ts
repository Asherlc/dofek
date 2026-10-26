import { describe, expect, it, vi } from "vitest";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogDatabaseFixture,
  climbingLogEntryFixture,
} from "./climbing-test-helpers.ts";

function named(
  providerId: string,
  id = "20000000-0000-4000-8000-000000000001",
  completed = false,
): ClimbingLogEntryDetail {
  const climb = climbingClimbFixture(providerId);
  return climbingLogEntryFixture({
    id,
    providerId,
    climb,
    climbId: climb.id,
    discipline: "rock_climbing",
    sourceName: providerId,
    attempts: [
      climbingAttemptFixture(id, {
        ropeMethod: "lead",
        ...(completed ? { outcome: "completed", usedAid: false, fellOrHung: false } : {}),
      }),
    ],
  });
}
function repository(logs: ClimbingLogEntryDetail[]) {
  const execute = vi.fn().mockResolvedValue(logs.map(climbingLogDatabaseFixture));
  return new ClimbingActivityLogEntryRepository(
    { execute },
    "20000000-0000-4000-8000-000000000002",
    "UTC",
  );
}
describe("ClimbingActivityLogEntryRepository", () => {
  it.each([true, false, null])("retains the database free-send state %s", async (freeSend) => {
    const log = named("openbeta");
    const execute = vi.fn().mockResolvedValue([{ ...climbingLogDatabaseFixture(log), freeSend }]);
    const repo = new ClimbingActivityLogEntryRepository(
      { execute },
      "20000000-0000-4000-8000-000000000002",
      "UTC",
    );
    const [result] = await repo.getLogEntries([log.id]);
    expect(result?.toDetail()).toMatchObject({ freeSend });
  });
  it("returns unique native map owners for each requested canonical activity", async () => {
    const climb = climbingClimbFixture("openbeta");
    const source = {
      ...climb,
      coordinates: { latitude: 0, longitude: 0 },
    };
    const areaOnly = {
      ...source,
      id: "20000000-0000-4000-8000-000000000044",
      coordinates: null,
      areaPath: source.areaPath.map((area) => ({
        ...area,
        coordinates: { latitude: 12, longitude: 0 },
      })),
    };
    const activityId = "30000000-0000-4000-8000-000000000001";
    const unknownActivityId = "30000000-0000-4000-8000-000000000002";
    const sourceLog = climbingLogEntryFixture({ activityId, climb: source });
    const areaLog = climbingLogEntryFixture({ activityId, climb: areaOnly });
    const unknownLog = climbingLogEntryFixture({ activityId: unknownActivityId, climb: null });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        { activityId: "group-one", memberActivityIds: [activityId] },
        { activityId: "group-two", memberActivityIds: [unknownActivityId] },
      ])
      .mockResolvedValueOnce(
        [sourceLog, sourceLog, areaLog, unknownLog].map(climbingLogDatabaseFixture),
      );
    const repo = new ClimbingActivityLogEntryRepository({ execute }, "user", "UTC");
    const result = await repo.getActivityMapLocations(["group-one", "group-two"]);
    expect(result.size).toBe(1);
    expect(result.get("group-one")).toEqual([
      {
        coordinates: source.coordinates,
        scope: "climb",
        objectId: source.id,
        providerId: "openbeta",
        name: source.name,
      },
      {
        coordinates: { latitude: 12, longitude: 0 },
        scope: "area",
        objectId: source.areaPath[0]?.id,
        providerId: "openbeta",
        name: source.areaPath[0]?.name,
      },
    ]);
    expect(await repo.getActivityMapLocations([])).toEqual(new Map());
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("uses native Climb GPS before Area GPS, including zero coordinates", async () => {
    const log = named("openbeta");
    if (!log.climb?.areaPath[0]) throw new Error("Expected catalogue fixture");
    log.climb.coordinates = { latitude: 0, longitude: 0 };
    log.climb.areaPath[0].coordinates = { latitude: 37, longitude: -122 };
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail().mapLocation).toEqual({
      coordinates: { latitude: 0, longitude: 0 },
      scope: "climb",
      objectId: log.climb.id,
      providerId: "openbeta",
      name: "Corner",
    });
  });
  it("uses the nearest coordinate-bearing Area while keeping the source path order", async () => {
    const log = named("mountain-project");
    const area = log.climb?.areaPath[0];
    if (!log.climb || !area) throw new Error("Expected catalogue fixture");
    log.climb.areaPath = [
      {
        ...area,
        id: "20000000-0000-4000-8000-000000000010",
        name: "Region",
        coordinates: { latitude: 40, longitude: -120 },
      },
      {
        ...area,
        id: "20000000-0000-4000-8000-000000000011",
        name: "Crag",
        coordinates: { latitude: 37, longitude: 0 },
      },
      { ...area, name: "Wall", coordinates: null },
    ];
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail().mapLocation).toEqual({
      coordinates: { latitude: 37, longitude: 0 },
      scope: "area",
      objectId: "20000000-0000-4000-8000-000000000011",
      providerId: "mountain-project",
      name: "Crag",
    });
    expect(result?.toDetail().climb?.areaPath.map((area) => area.name)).toEqual([
      "Region",
      "Crag",
      "Wall",
    ]);
  });
  it.each([true, false])(
    "returns no map location when native coordinates are absent (Climb: %s)",
    async (hasClimb) => {
      const log = hasClimb ? named("openbeta") : climbingLogEntryFixture();
      const [result] = await repository([log]).getLogEntries([log.id]);
      expect(result?.toDetail().mapLocation).toBeNull();
    },
  );
  it.each([true, false])(
    "keeps map ownership with the preferred complete provider graph (GPS: %s)",
    async (hasCoordinates) => {
      const earlier = named("mountain-project");
      const preferred = named("openbeta", "20000000-0000-4000-8000-000000000006", true);
      if (!earlier.climb || !preferred.climb) throw new Error("Expected catalogue fixtures");
      earlier.climb.coordinates = { latitude: 45, longitude: -100 };
      preferred.climb.coordinates = hasCoordinates ? { latitude: 37, longitude: -122 } : null;
      const [result] = await repository([earlier, preferred]).getActivityLogEntries("activity");
      expect(result?.toDetail().providerId).toBe("openbeta");
      expect(result?.toDetail().mapLocation).toEqual(
        hasCoordinates
          ? {
              coordinates: { latitude: 37, longitude: -122 },
              scope: "climb",
              objectId: preferred.climb.id,
              providerId: "openbeta",
              name: "Corner",
            }
          : null,
      );
    },
  );
  it.each([
    { facts: {}, labels: ["sent"] },
    { facts: { attemptIndex: 1, receivedBeta: false }, labels: ["sent", "Onsight"] },
    { facts: { attemptIndex: 1, receivedBeta: true }, labels: ["sent", "Flash"] },
    { facts: { attemptIndex: 1, receivedBeta: null }, labels: ["sent"] },
    { facts: { attemptIndex: 2, receivedBeta: true }, labels: ["sent"] },
    { facts: { attemptIndex: 1, receivedBeta: false, hadCompletedBefore: true }, labels: ["sent"] },
    {
      facts: { attemptIndex: 1, receivedBeta: false, priorFailedAttemptsGroundUp: true },
      labels: ["sent"],
    },
    { facts: { outcome: "failed" }, labels: [] },
    { facts: { outcome: null }, labels: [] },
    { facts: { fellOrHung: true }, labels: [] },
    { facts: { fellOrHung: null }, labels: [] },
    { facts: { usedAid: true }, labels: [] },
    { facts: { usedAid: null }, labels: [] },
  ] satisfies Array<{
    facts: Partial<ClimbingLogEntryDetail["attempts"][number]>;
    labels: string[];
  }>)("derives rock labels from independent attempt facts: $facts", async ({ facts, labels }) => {
    const log = named("openbeta", undefined, true);
    log.attempts = [
      climbingAttemptFixture(log.id, {
        outcome: "completed",
        usedAid: false,
        fellOrHung: false,
        ...facts,
      }),
    ];
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail().attempts[0]?.rockResultLabels).toEqual(labels);
  });
  it.each([false, true, null])(
    "requires a recorded absence of dabs for a boulder send (%s)",
    async (dabbed) => {
      const log = named("openbeta", undefined, true);
      if (!log.climb) throw new Error("Expected catalogue fixture");
      log.climb.kind = "boulder";
      log.attempts[0] = climbingAttemptFixture(log.id, {
        outcome: "completed",
        usedAid: false,
        fellOrHung: false,
        dabbed,
      });
      const [result] = await repository([log]).getLogEntries([log.id]);
      expect(result?.toDetail().attempts[0]?.rockResultLabels).toEqual(
        dabbed === false ? ["sent"] : [],
      );
    },
  );
  it("keeps mountaineering completions separate from rock send labels", async () => {
    const log = named("openbeta", undefined, true);
    log.discipline = "mountaineering";
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail().recordedClimbOutcome).toBe("completed");
    expect(result?.toDetail().attempts[0]?.rockResultLabels).toEqual([]);
    if (!log.climb) throw new Error("Expected catalogue fixture");
    log.climb.kind = "summit";
    log.discipline = "rock_climbing";
    const [summit] = await repository([log]).getLogEntries([log.id]);
    expect(summit?.toDetail().attempts[0]?.rockResultLabels).toEqual([]);
  });
  it.each([
    { outcomes: ["failed", "completed"], expected: "completed" },
    { outcomes: ["failed", "failed"], expected: "failed" },
    { outcomes: ["failed", null], expected: null },
    { outcomes: [], expected: null },
  ] as const)("projects a whole-climb outcome from $outcomes", async ({ outcomes, expected }) => {
    const log = named("openbeta");
    log.attempts = outcomes.map((outcome) => climbingAttemptFixture(log.id, { outcome }));
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail().recordedClimbOutcome).toBe(expected);
    expect(result?.toDetail().recordedClimbAttemptCount).toBe(outcomes.length);
  });
  it.each([null, "completed", "failed"] as const)(
    "leaves Mountain Project attempt counts unknown while retaining the %s result and rope method",
    async (outcome) => {
      const log = named("mountain-project");
      log.attempts = [climbingAttemptFixture(log.id, { outcome, ropeMethod: "top_rope" })];
      const [result] = await repository([log]).getLogEntries([log.id]);
      expect(result?.toDetail()).toMatchObject({
        recordedClimbAttemptCount: null,
        recordedClimbOutcome: outcome,
        attempts: [{ outcome, ropeMethod: "top_rope" }],
      });
    },
  );
  it("groups repeated identified pitches while retaining separate unidentified pitch occurrences", async () => {
    const log = named("openbeta");
    if (!log.climb) throw new Error("Expected catalogue fixture");
    const pitch = {
      id: "20000000-0000-4000-8000-000000000020",
      climbId: log.climb.id,
      externalId: "pitch-one",
      number: 1,
      name: "First pitch",
      publishedGrades: [{ value: "5.9", system: "yds" }],
    } as const;
    log.climb.pitches = [{ ...pitch, publishedGrades: [...pitch.publishedGrades] }];
    log.attempts = [
      climbingAttemptFixture(log.id, { outcome: "failed" }),
      ...["failed", "completed"].map((outcome, index) =>
        climbingAttemptFixture(log.id, {
          id: `20000000-0000-4000-8000-00000000002${index + 1}`,
          scope: "pitch",
          pitchId: pitch.id,
          outcome: outcome === "failed" ? "failed" : "completed",
        }),
      ),
      ...[3, 4].map((index) =>
        climbingAttemptFixture(log.id, {
          id: `20000000-0000-4000-8000-00000000002${index}`,
          scope: "pitch",
        }),
      ),
    ];
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail()).toMatchObject({
      recordedClimbAttemptCount: 1,
      recordedPitchAttemptCount: 4,
      recordedClimbOutcome: "failed",
      pitchResults: [
        {
          pitch,
          attemptIds: [log.attempts[1]?.id, log.attempts[2]?.id],
          recordedAttemptCount: 2,
          recordedOutcome: "completed",
          displayGrade: "5.9",
        },
        {
          pitch: null,
          attemptIds: [log.attempts[3]?.id],
          recordedAttemptCount: 1,
          recordedOutcome: null,
          displayGrade: null,
        },
        {
          pitch: null,
          attemptIds: [log.attempts[4]?.id],
          recordedAttemptCount: 1,
          recordedOutcome: null,
          displayGrade: null,
        },
      ],
    });
  });
  it.each([
    { kind: "route", ropeMethod: "lead" },
    { kind: "route", ropeMethod: "top_rope" },
    { kind: "route", ropeMethod: null },
    { kind: "boulder", ropeMethod: "lead" },
  ] as const)(
    "derives Pinkpoint only for a free lead route completion ($kind/$ropeMethod)",
    async ({ kind, ropeMethod }) => {
      const log = named("openbeta");
      if (!log.climb) throw new Error("Expected catalogue fixture");
      log.climb.kind = kind;
      log.attempts = [
        climbingAttemptFixture(log.id, {
          ropeMethod,
          outcome: "completed",
          usedAid: false,
          fellOrHung: false,
          usedPreplacedProtection: true,
          dabbed: false,
        }),
      ];
      const [result] = await repository([log]).getLogEntries([log.id]);
      expect(result?.toDetail().attempts[0]?.rockResultLabels).toEqual(
        kind === "route" && ropeMethod === "lead" ? ["sent", "Pinkpoint"] : ["sent"],
      );
    },
  );
  it("projects an unknown scoped occurrence without requiring a grade or source date", async () => {
    const log = climbingLogEntryFixture();
    log.attempts = [climbingAttemptFixture(log.id)];
    const [result] = await repository([log]).getLogEntries([log.id]);
    expect(result?.toDetail()).toMatchObject({
      climbedOn: null,
      climb: null,
      displayGrade: null,
      recordedClimbAttemptCount: 1,
      recordedClimbOutcome: null,
      attempts: [{ scope: "climb", rockResultLabels: [] }],
    });
  });
  it("chooses a complete provider graph while preserving source links", async () => {
    const left = named("mountain-project");
    left.raw = { URL: "https://www.mountainproject.com/route/105734732/swiss-cheese" };
    const right = named("openbeta", "20000000-0000-4000-8000-000000000006", true);
    right.raw = { climb: { uuid: "10000000-0000-4000-8000-000000000001" } };
    const rows = await repository([left, right]).getActivityLogEntries("activity");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toDetail()).toMatchObject({
      id: right.id,
      providerId: "openbeta",
      climb: { providerId: "openbeta" },
      recordedClimbOutcome: "completed",
      sourceName: "mountain-project, openbeta",
      sourceLinks: [
        { providerId: "mountain-project", kind: "route" },
        { providerId: "openbeta", kind: "route" },
      ],
    });
  });
  it("keeps same-provider repetitions while consolidating each other provider once", async () => {
    const first = named("mountain-project");
    const second = named("mountain-project", "20000000-0000-4000-8000-000000000006");
    const other = named("openbeta", "20000000-0000-4000-8000-000000000007");
    expect(await repository([first, second, other]).getActivityLogEntries("activity")).toHaveLength(
      2,
    );
  });
  it("keeps different recorded methods and scopes distinct", async () => {
    const lead = named("mountain-project");
    const follow = named("openbeta", "20000000-0000-4000-8000-000000000006");
    follow.attempts = [climbingAttemptFixture(follow.id, { ropeMethod: "follow" })];
    const pitch = named("thecrag", "20000000-0000-4000-8000-000000000007");
    pitch.attempts = [climbingAttemptFixture(pitch.id, { scope: "pitch", ropeMethod: "lead" })];
    expect(await repository([lead, follow, pitch]).getActivityLogEntries("activity")).toHaveLength(
      3,
    );
  });
  it("keeps unnamed objects and direct provider record requests separate", async () => {
    const first = named("mountain-project");
    const second = named("openbeta", "20000000-0000-4000-8000-000000000006");
    first.climb = null;
    first.climbId = null;
    expect(await repository([first, second]).getActivityLogEntries("activity")).toHaveLength(2);
    expect(
      await repository([named("mountain-project"), second]).getLogEntries([first.id, second.id]),
    ).toHaveLength(2);
  });
  it("orders known rock grades before ungraded observations with stable ties", async () => {
    const base = named("openbeta");
    const lower = named("openbeta", "20000000-0000-4000-8000-000000000006");
    const higher = named("openbeta", "20000000-0000-4000-8000-000000000007");
    const ungraded = named("openbeta", "20000000-0000-4000-8000-000000000008");
    if (!lower.climb || !higher.climb || !ungraded.climb)
      throw new Error("Expected catalogue fixtures");
    for (const [index, log] of [lower, higher, ungraded].entries()) {
      if (!log.climb) throw new Error("Expected catalogue fixture");
      log.climb.id = `20000000-0000-4000-8000-00000000001${index}`;
      log.climb.externalId = `distinct-climb-${index}`;
      log.climbId = log.climb.id;
    }
    lower.climb.publishedGrades = [{ value: "5.9", system: "yds" }];
    higher.climb.publishedGrades = [{ value: "5.11a", system: "yds" }];
    ungraded.climb.publishedGrades = [];
    expect(
      (await repository([ungraded, lower, base, higher]).getActivityLogEntries("activity")).map(
        (row) => row.toDetail().id,
      ),
    ).toEqual([higher.id, base.id, lower.id, ungraded.id]);
  });
});
