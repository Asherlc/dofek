import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { userProfile } from "../../../../src/db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { ClimbingForecastRepository } from "./climbing-forecast-observations.ts";

let context: TestContext;
const owner = randomUUID();
const otherOwner = randomUUID();
const day = "2026-10-12";
const range = { startDate: day, endDate: "2026-10-15" };

beforeAll(async () => {
  context = await setupTestDatabase();
  await context.db.insert(userProfile).values([
    { id: owner, name: "Test climber" },
    { id: otherOwner, name: "Other climber" },
  ]);
  for (const userId of [owner, otherOwner]) {
    for (const providerId of ["kaya", "openbeta"]) {
      await ensureProvider(context.db, providerId, providerId, undefined, userId);
    }
  }
});

afterAll(async () => context?.cleanup());

function entry(
  externalId: string,
  climbExternalId: string | null,
  attempts: NonNullable<SourceClimbingLogEntry["attempts"]>,
  climbedOn = day,
): SourceClimbingLogEntry {
  return {
    externalId,
    climbedOn,
    discipline: "rock_climbing",
    climb: {
      externalId: climbExternalId,
      name: "Same named boulder",
      kind: "boulder",
      setting: "outdoor",
      publishedGrades: [{ system: "v_scale", value: "V4" }],
    },
    attempts,
  };
}

it("rolls up explicit labels while preserving scope, identity, and ownership", async () => {
  await persistClimbingLogEntries(context.db, {
    userId: owner,
    providerId: "kaya",
    entries: [
      entry("send", "main", [
        { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        { scope: "climb" },
      ]),
      entry("same-day-miss", "main", [{ scope: "climb", sourceResult: "Attempt" }]),
      entry("failed", "different", [{ scope: "climb", sourceResult: "Attempt" }]),
      entry("ambiguous", "unknown", [{ scope: "climb", sourceResult: "Completed" }]),
      {
        ...entry("pitch-only", "pitch-route", []),
        climb: {
          externalId: "pitch-route",
          name: "Pitch route",
          kind: "route",
          setting: "outdoor",
          publishedGrades: [{ system: "ewbank", value: "20" }],
        },
        attempts: [
          {
            scope: "pitch",
            ropeMethod: "lead",
            protectionUsed: ["sport"],
            sourceResult: "Attempt",
          },
        ],
      },
      entry("unidentified", null, [{ scope: "climb", sourceResult: "Attempt" }]),
      entry("next-day", "main", [{ scope: "climb", sourceResult: "Attempt" }], "2026-10-13"),
    ],
  });
  await persistClimbingLogEntries(context.db, {
    userId: owner,
    providerId: "openbeta",
    entries: [entry("unlabeled-display-send", "native", [{ scope: "climb" }])],
  });
  await persistClimbingLogEntries(context.db, {
    userId: otherOwner,
    providerId: "kaya",
    entries: [entry("other-owner", "main", [{ scope: "climb", sourceResult: "Attempt" }])],
  });

  const repo = new ClimbingForecastRepository(context.db, owner);
  const rows = await repo.listClimbDays(range);
  expect(rows.map(({ climb_external_id, date, sent }) => [climb_external_id, date, sent])).toEqual([
    ["different", day, false],
    ["main", day, true],
    ["main", "2026-10-13", false],
  ]);
  expect(rows[1]).toMatchObject({
    provider_id: "kaya",
    setting: "outdoor",
    style: "bouldering",
    grade_system: "v_scale",
    grade: "V4",
    grade_provenance: "current_assigned",
  });

  const restricted = new ClimbingForecastRepository(context.db, owner, "UTC", {
    kind: "limited",
    paid: false,
    reason: "free_recent_week",
    startDate: "2026-10-13",
    endDateExclusive: "2026-10-14",
  });
  expect(await restricted.listClimbDays(range)).toEqual([rows[2]]);
});

it("excludes entries whose attached activity is soft-deleted or absent from the provider", async () => {
  const activeId = randomUUID();
  const deletedId = randomUUID();
  const absentId = randomUUID();
  for (const [id, providerId] of [
    [activeId, "openbeta"],
    [deletedId, "kaya"],
    [absentId, "kaya"],
  ] as const) {
    await context.db.insert(activity).values({
      id,
      userId: otherOwner,
      providerId,
      externalId: randomUUID(),
      canonicalType: "climbing",
      providerType: "climbing",
      startedAt: new Date("2026-10-12T12:00:00Z"),
      endedAt: new Date("2026-10-12T13:00:00Z"),
    });
  }
  await context.db
    .update(activity)
    .set({ deletedAt: new Date() })
    .where(eq(activity.id, deletedId));
  await context.db
    .update(activity)
    .set({ providerAbsentAt: new Date() })
    .where(eq(activity.id, absentId));

  await persistClimbingLogEntries(context.db, {
    userId: otherOwner,
    providerId: "kaya",
    entries: [
      entry("visibility-standalone", "visibility-standalone", [
        { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
      ]),
      {
        ...entry("visibility-active", "visibility-active", [
          { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        ]),
        activityId: activeId,
      },
      {
        ...entry("visibility-deleted", "visibility-deleted", [
          { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        ]),
        activityId: deletedId,
      },
      {
        ...entry("visibility-absent", "visibility-absent", [
          { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        ]),
        activityId: absentId,
      },
    ],
  });

  const rows = await new ClimbingForecastRepository(context.db, otherOwner).listClimbDays(range);
  expect(
    rows
      .map(({ climb_external_id }) => climb_external_id)
      .filter((id) => id.startsWith("visibility-")),
  ).toEqual(["visibility-active", "visibility-standalone"]);
});
