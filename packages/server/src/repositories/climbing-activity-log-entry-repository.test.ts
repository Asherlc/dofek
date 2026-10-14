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
