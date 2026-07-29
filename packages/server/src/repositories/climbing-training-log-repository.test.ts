import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../lib/typed-sql.ts";
import {
  ClimbingTrainingLogRepository,
  type FingerLoadingInput,
  readFingerLoadingRange,
} from "./climbing-training-log-repository.ts";
import { collectSqlText } from "./test-helpers.ts";

const ensurePushProvider = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./push-provider-repository.ts", () => ({ ensurePushProvider }));

const fingerLoadingInput: FingerLoadingInput = {
  bodyweightKg: 72.5,
  edgeSizeMm: 20,
  exercise: "max_hang",
  externalLoadKg: 17.5,
  gripPosition: "half_crimp",
  holdDurationSeconds: 10,
  laterality: "both",
  notes: "Controlled",
  restIntervalSeconds: 180,
  rpe: 8,
  setCount: 5,
  startedAt: "2026-07-28T17:00:00.000Z",
};

const fingerLoadingRow = {
  activity_id: "activity-1",
  bodyweight_kg: 72.5,
  edge_size_mm: 20,
  exercise: "max_hang",
  external_load_kg: 17.5,
  grip_position: "half_crimp",
  hold_duration_seconds: 10,
  laterality: "both",
  notes: "Controlled",
  rest_interval_seconds: 180,
  rpe: 8,
  set_count: 5,
  started_at: "2026-07-28T17:00:00.000Z",
};

const fingerLoadingDetail = {
  activityId: "activity-1",
  bodyweightKg: 72.5,
  edgeSizeMm: 20,
  effectiveLoadKg: 90,
  exercise: "max_hang",
  externalLoadKg: 17.5,
  gripPosition: "half_crimp",
  holdDurationSeconds: 10,
  laterality: "both",
  notes: "Controlled",
  restIntervalSeconds: 180,
  rpe: 8,
  setCount: 5,
  startedAt: "2026-07-28T17:00:00.000Z",
};

type TrainingLogDatabase = ConstructorParameters<typeof ClimbingTrainingLogRepository>[0];

function makeDatabase(results: Record<string, unknown>[][]) {
  let resultIndex = 0;
  const execute = vi.fn(async () => results[resultIndex++] ?? []);
  const transactionDatabase = { execute };
  const transaction = vi.fn(
    async (callback: (database: typeof transactionDatabase) => Promise<unknown>) =>
      callback(transactionDatabase),
  );
  const database: TrainingLogDatabase = { execute, transaction };
  return { database, execute, transaction };
}

beforeEach(() => {
  ensurePushProvider.mockClear();
});

describe("readFingerLoadingRange", () => {
  it("scopes the query and derives effective load from canonical raw values", async () => {
    const execute = vi.fn(
      async (_query: SQL): Promise<Record<string, unknown>[]> => [fingerLoadingRow],
    );
    const database = { execute } satisfies SchemaExecutionDatabase;

    const result = await readFingerLoadingRange({
      database,
      endDate: "2026-07-29",
      startDate: "2026-07-01",
      timezone: "America/Los_Angeles",
      userId: "user-1",
    });

    expect(result).toEqual([fingerLoadingDetail]);
    expect(execute).toHaveBeenCalledOnce();
    const query = execute.mock.calls[0]?.[0];
    const queryText = collectSqlText(query);
    expect(queryText).toContain("FROM fitness.v_activity AS a");
    expect(queryText).toContain("entry.activity_id = ANY(a.member_activity_ids)");
    expect(queryText).toContain("WHERE a.user_id =");
    expect(JSON.stringify(query)).toContain("user-1");
    expect(JSON.stringify(query)).toContain("America/Los_Angeles");
    expect(JSON.stringify(query)).toContain("2026-07-01");
    expect(JSON.stringify(query)).toContain("2026-07-29");
  });
});

describe("ClimbingTrainingLogRepository", () => {
  it("writes and returns a complete finger-loading protocol", async () => {
    const { database, execute, transaction } = makeDatabase([
      [{ id: "activity-1" }],
      [],
      [fingerLoadingRow],
    ]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1", "America/Los_Angeles");

    await expect(repository.logFingerLoading(fingerLoadingInput)).resolves.toEqual(
      fingerLoadingDetail,
    );

    expect(ensurePushProvider).toHaveBeenCalledWith({
      database,
      providerId: "dofek",
      providerName: "Dofek App",
      userId: "user-1",
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("INSERT INTO fitness.activity");
    const entryInsert = collectSqlText(execute.mock.calls[1]?.[0]);
    expect(entryInsert).toContain("INSERT INTO fitness.finger_loading_entry");
    expect(entryInsert).toContain("max_hang");
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("17.5");
    const readBack = collectSqlText(execute.mock.calls[2]?.[0]);
    expect(readBack).toContain("FROM fitness.v_activity AS a");
    expect(readBack).toContain("activity-1");
  });

  it("fails when a finger-loading activity insert returns no id", async () => {
    const { database } = makeDatabase([[]]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1");

    await expect(repository.logFingerLoading(fingerLoadingInput)).rejects.toThrow(
      "Finger-loading activity insert returned no id",
    );
  });

  it("fails when a saved finger-loading activity cannot be read back", async () => {
    const { database } = makeDatabase([[{ id: "activity-1" }], [], []]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1");

    await expect(repository.logFingerLoading(fingerLoadingInput)).rejects.toThrow(
      "Saved finger-loading activity could not be read",
    );
  });

  it("writes ordered climbing attempts and derives a mixed-attempt send", async () => {
    const { database, execute } = makeDatabase([
      [{ id: "activity-1" }],
      [{ id: "climb-1" }],
      [],
      [],
    ]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1");

    await expect(
      repository.logClimbingSession({
        climbs: [
          {
            attempts: [
              { failureReason: "technique", notes: "Missed foot", outcome: "failed" },
              { failureReason: null, notes: null, outcome: "sent" },
            ],
            climbType: "boulder",
            grade: "V6",
            gradeSystem: "v_scale",
            holdType: "crimp",
            routeName: "Moon Arete",
            wallAngleDegrees: 35,
          },
        ],
        endedAt: "2026-07-28T18:00:00.000Z",
        locationName: "Test Board",
        startedAt: "2026-07-28T17:00:00.000Z",
      }),
    ).resolves.toEqual({
      activityId: "activity-1",
      climbs: [{ attemptCount: 2, id: "climb-1", sent: true }],
    });

    expect(ensurePushProvider).toHaveBeenCalledWith({
      database,
      providerId: "dofek",
      providerName: "Dofek App",
      userId: "user-1",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("rock_climbing");
    expect(collectSqlText(execute.mock.calls[1]?.[0])).toContain(
      "INSERT INTO fitness.climbing_entry",
    );
    const firstAttempt = collectSqlText(execute.mock.calls[2]?.[0]);
    const secondAttempt = collectSqlText(execute.mock.calls[3]?.[0]);
    expect(firstAttempt).toContain("technique");
    expect(firstAttempt).toContain("Missed foot");
    expect(secondAttempt).toContain("sent");
    expect(JSON.stringify(execute.mock.calls[2]?.[0])).toContain("1");
    expect(JSON.stringify(execute.mock.calls[3]?.[0])).toContain("2");
  });

  it("derives an all-failed climb as unsent", async () => {
    const { database } = makeDatabase([[{ id: "activity-1" }], [{ id: "climb-1" }], []]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1");

    await expect(
      repository.logClimbingSession({
        climbs: [
          {
            attempts: [{ failureReason: "fell", notes: null, outcome: "failed" }],
            climbType: "route",
            grade: "5.11a",
            gradeSystem: "yds",
            holdType: null,
            routeName: null,
            wallAngleDegrees: null,
          },
        ],
        endedAt: null,
        locationName: null,
        startedAt: "2026-07-28T17:00:00.000Z",
      }),
    ).resolves.toEqual({
      activityId: "activity-1",
      climbs: [{ attemptCount: 1, id: "climb-1", sent: false }],
    });
  });

  it("fails when a climbing activity insert returns no id", async () => {
    const { database } = makeDatabase([[]]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1");

    await expect(
      repository.logClimbingSession({
        climbs: [],
        endedAt: null,
        locationName: null,
        startedAt: "2026-07-28T17:00:00.000Z",
      }),
    ).rejects.toThrow("Climbing activity insert returned no id");
  });

  it("fails when a climbing entry insert returns no id", async () => {
    const { database } = makeDatabase([[{ id: "activity-1" }], []]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1");

    await expect(
      repository.logClimbingSession({
        climbs: [
          {
            attempts: [{ failureReason: "fell", notes: null, outcome: "failed" }],
            climbType: "boulder",
            grade: "V5",
            gradeSystem: "v_scale",
            holdType: "sloper",
            routeName: null,
            wallAngleDegrees: 20,
          },
        ],
        endedAt: null,
        locationName: null,
        startedAt: "2026-07-28T17:00:00.000Z",
      }),
    ).rejects.toThrow("Climbing entry insert returned no id");
  });

  it("reads finger-loading history through the visible activity view", async () => {
    const { database, execute } = makeDatabase([[fingerLoadingRow]]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1", "America/Los_Angeles");

    await expect(repository.getFingerLoadingHistory(30)).resolves.toEqual([fingerLoadingDetail]);

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("FROM fitness.v_activity AS a");
    expect(queryText).toContain("user-1");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("30");
  });

  it("reads a requested finger-loading date range", async () => {
    const { database, execute } = makeDatabase([[fingerLoadingRow]]);
    const repository = new ClimbingTrainingLogRepository(database, "user-1", "America/Los_Angeles");

    await expect(repository.getFingerLoadingRange("2026-07-01", "2026-07-29")).resolves.toEqual([
      fingerLoadingDetail,
    ]);

    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("2026-07-01");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("2026-07-29");
  });
});
