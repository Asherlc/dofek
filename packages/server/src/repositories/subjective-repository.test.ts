import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubjectiveRepository } from "./subjective-repository.ts";

const USER_ID = "10000000-0000-4000-8000-000000002247";

function makeRepository(responses: unknown[][] = []) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  execute.mockResolvedValue([]);
  const database = { execute, transaction: vi.fn() };
  database.transaction.mockImplementation(async (callback) => callback(database));
  const repository = new SubjectiveRepository(database, USER_ID, "UTC");
  return { repository, execute, database };
}

const checkInRow = {
  id: "30000000-0000-4000-8000-000000002247",
  date: "2026-08-02",
  created_at: "2026-08-02T08:00:00Z",
  updated_at: "2026-08-02T08:00:00Z",
};

describe("SubjectiveRepository", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("distinguishes an unlogged date from an explicit all-clear check-in", async () => {
    const { repository } = makeRepository([[]]);
    await expect(repository.checkIn("2026-08-02")).resolves.toEqual({
      date: "2026-08-02",
      logged: false,
      symptoms: [],
    });
  });

  it("replaces symptoms atomically while preserving an all-clear header", async () => {
    const symptom = {
      id: "40000000-0000-4000-8000-000000002247",
      body_region_id: "left_hand_index_a2_pulley",
      kind: "tenderness",
      score: 4,
    };
    const { repository, database } = makeRepository([
      [checkInRow],
      [],
      [],
      [checkInRow],
      [symptom],
    ]);

    await expect(
      repository.saveCheckIn("2026-08-02", [
        { bodyRegionId: "left_hand_index_a2_pulley", kind: "tenderness", score: 4 },
      ]),
    ).resolves.toEqual({ date: "2026-08-02", logged: true, symptoms: [symptom] });
    expect(database.transaction).toHaveBeenCalledOnce();
  });

  it("throws when the check-in upsert returns no row", async () => {
    const { repository } = makeRepository([[]]);

    await expect(repository.saveCheckIn("2026-08-02", [])).rejects.toThrow(
      "Subjective check-in upsert returned no row",
    );
  });

  it("inserts all symptoms in one statement", async () => {
    const { repository, database } = makeRepository([[checkInRow], [], [], [checkInRow], []]);

    await repository.saveCheckIn("2026-08-02", [
      { bodyRegionId: "left_hand", kind: "soreness", score: 3 },
      { bodyRegionId: "right_knee", kind: "stiffness", score: 5 },
    ]);

    const query = new PgDialect().sqlToQuery(database.execute.mock.calls[2]?.[0]);
    expect(query.sql).toContain("INSERT INTO fitness.subjective_symptom");
    expect(query.params).toEqual(
      expect.arrayContaining([checkInRow.id, "left_hand", "right_knee"]),
    );
    expect(database.execute).toHaveBeenCalledTimes(5);
  });

  it("assembles date-window check-ins and overlapping injury events", async () => {
    const symptom = {
      id: "40000000-0000-4000-8000-000000002247",
      check_in_id: checkInRow.id,
      body_region_id: "left_hand_index_a2_pulley",
      kind: "tenderness",
      score: 4,
    };
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand_index_a2_pulley",
      onset_date: "2026-08-01",
      resolved_date: null,
      severity: 4,
      description: "Morning tenderness",
      created_at: "2026-08-01T08:00:00.000Z",
      updated_at: "2026-08-01T08:00:00.000Z",
    };
    const { repository, execute } = makeRepository([[checkInRow], [injury], [symptom]]);

    await expect(repository.timeline("2026-08-02", "2026-08-03")).resolves.toEqual({
      checkIns: [{ date: "2026-08-02", logged: true, symptoms: [symptom] }],
      injuries: [injury],
    });

    const symptomQuery = execute.mock.calls
      .map(([query]) => new PgDialect().sqlToQuery(query))
      .find((query) => query.sql.includes("fitness.subjective_symptom"));
    expect(symptomQuery?.params).toContain(checkInRow.id);
  });

  it("scopes injury writes to the authenticated user", async () => {
    const { repository, execute } = makeRepository([
      [
        {
          id: "50000000-0000-4000-8000-000000002247",
          kind: "niggle",
          body_region_id: "left_hand",
          onset_date: "2026-08-02",
          resolved_date: null,
          severity: 2,
          description: "Hand soreness",
          created_at: "2026-08-02T08:00:00Z",
          updated_at: "2026-08-02T08:00:00Z",
        },
      ],
    ]);

    await repository.createInjury({
      kind: "niggle",
      bodyRegionId: "left_hand",
      onsetDate: "2026-08-02",
      resolvedDate: null,
      severity: 2,
      description: "Hand soreness",
    });

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("user_id");
    expect(query.params).toContain(USER_ID);
  });

  it("accepts an explicitly unrecorded injury severity", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand",
      onset_date: "2026-08-02",
      resolved_date: null,
      severity: null,
      description: "Hand soreness",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { repository } = makeRepository([[injury]]);

    await expect(
      repository.createInjury({
        kind: "niggle",
        bodyRegionId: "left_hand",
        onsetDate: "2026-08-02",
        resolvedDate: null,
        severity: null,
        description: "Hand soreness",
      }),
    ).resolves.toEqual(injury);
  });

  it("throws when the injury insert returns no row", async () => {
    const { repository } = makeRepository([[]]);

    await expect(
      repository.createInjury({
        kind: "niggle",
        bodyRegionId: "left_hand",
        onsetDate: "2026-08-02",
        resolvedDate: null,
        severity: null,
        description: "Hand soreness",
      }),
    ).rejects.toThrow("Injury insert returned no row");
  });

  it("clears an injury resolution date with an explicit NULL assignment", async () => {
    const { repository, execute } = makeRepository([[]]);

    await expect(
      repository.updateInjury("50000000-0000-4000-8000-000000002247", {
        resolvedDate: null,
      }),
    ).resolves.toBeNull();

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("resolved_date = NULL");
    expect(query.params).toContain("50000000-0000-4000-8000-000000002247");
    expect(query.params).toContain(USER_ID);
  });

  it("updates every supplied injury field", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "injury",
      body_region_id: "right_knee",
      onset_date: "2026-08-01",
      resolved_date: "2026-08-10",
      severity: 7,
      description: "Updated knee pain",
      created_at: "2026-08-01T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { repository, execute } = makeRepository([[injury]]);

    await expect(
      repository.updateInjury(injury.id, {
        kind: "injury",
        bodyRegionId: "right_knee",
        onsetDate: "2026-08-01",
        resolvedDate: "2026-08-10",
        severity: 7,
        description: "Updated knee pain",
      }),
    ).resolves.toEqual(injury);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.params).toEqual(
      expect.arrayContaining([
        "injury",
        "right_knee",
        "2026-08-01",
        "2026-08-10",
        7,
        "Updated knee pain",
      ]),
    );
  });

  it("always updates the timestamp when no injury fields change", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand",
      onset_date: "2026-08-02",
      resolved_date: null,
      severity: 2,
      description: "Hand soreness",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { repository, execute } = makeRepository([[injury]]);

    await expect(repository.updateInjury(injury.id, {})).resolves.toEqual(injury);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("updated_at = now()");
    expect(query.params).not.toContain(undefined);
  });

  it("reports false when deleting an injury that is not owned by the user", async () => {
    const { repository } = makeRepository([[]]);

    await expect(repository.deleteInjury("50000000-0000-4000-8000-000000002247")).resolves.toBe(
      false,
    );
  });

  it("reports true when deleting an owned injury", async () => {
    const { repository } = makeRepository([[{ id: "50000000-0000-4000-8000-000000002247" }]]);

    await expect(repository.deleteInjury("50000000-0000-4000-8000-000000002247")).resolves.toBe(
      true,
    );
  });

  it("rejects a malformed deleted injury row", async () => {
    const { repository } = makeRepository([[{ unexpected: "value" }]]);

    await expect(repository.deleteInjury("50000000-0000-4000-8000-000000002247")).rejects.toThrow();
  });

  it("does not query symptoms when the timeline has no check-ins", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand",
      onset_date: "2026-08-02",
      resolved_date: null,
      severity: 2,
      description: "Hand soreness",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { repository, execute } = makeRepository([[], [injury]]);

    await expect(repository.timeline("2026-08-02", "2026-08-03")).resolves.toEqual({
      checkIns: [],
      injuries: [injury],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
