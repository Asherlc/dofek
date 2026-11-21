import { strengthExerciseIdentityKey } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { StrengthExerciseOrderRepository } from "./strength-exercise-order-repository.ts";

const dialect = new PgDialect();

function makeRepository(
  rows: unknown[],
  accessWindow = { kind: "full" as const, paid: true, reason: "paid_grant" },
) {
  const execute = vi.fn().mockResolvedValue({ rows });
  const db: Pick<Database, "execute"> = { execute };
  const repo = new StrengthExerciseOrderRepository(db, "user-1", "UTC", accessWindow);
  return { repo, execute };
}

describe("StrengthExerciseOrderRepository", () => {
  describe("SQL query compilation and filters", () => {
    it("applies user_id, provider_id crimpd, and finite range filter", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getExerciseOrders(30);

      expect(execute).toHaveBeenCalledTimes(1);
      const compiled = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiled.sql).toContain("member.provider_id = 'crimpd'");
      expect(compiled.sql).toContain("a.user_id =");
      expect(compiled.sql).toContain("a.started_at > CURRENT_TIMESTAMP -");
      expect(compiled.params).toContain("user-1");
      expect(compiled.params).toContain(30);
    });

    it("applies tier visibility access window when restricted", async () => {
      const { repo, execute } = makeRepository([], {
        kind: "restricted",
        paid: false,
        reason: "free_tier",
        startDate: "2026-01-01",
        endDateExclusive: "2026-04-01",
      });
      await repo.getExerciseOrders(null);

      expect(execute).toHaveBeenCalledTimes(1);
      const compiled = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiled.sql).toContain("a.started_at >= (CAST(");
      expect(compiled.sql).toContain("a.started_at < (CAST(");
    });
  });

  describe("Projection and domain semantics", () => {
    const makeRow = (overrides: Record<string, unknown> = {}) => ({
      canonical_activity_id: "11111111-1111-4111-8111-111111111111",
      workout_date: "2026-05-01",
      started_at: "2026-05-01T10:00:00Z",
      member_activity_id: "22222222-2222-4222-8222-222222222222",
      member_external_id: "ext-1",
      exercise_name: "Weighted Pull Up",
      equipment: null,
      exercise_index: 1,
      set_index: 0,
      reps: 5,
      raw: {
        LOG_ID: "ext-1",
        ACTIVITY_ORDER: "2",
        SET_ORDER: "1",
        COMPLETE: "true",
        RESISTANCE: "20",
        WEIGHT_UNIT: "KG",
        REPS: "5",
        EXERCISE: "Weighted Pull Up",
      },
      ...overrides,
    });

    it("returns Crimpd-only baseline when preceded by a loaded completed exercise", async () => {
      const precedingRow = makeRow({
        exercise_name: "Bench Press",
        equipment: "barbell",
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "80",
          WEIGHT_UNIT: "KG",
          REPS: "5",
          EXERCISE: "Bench Press",
        },
      });
      const pullUpRow = makeRow({
        exercise_name: "Weighted Pull Up",
        exercise_index: 1,
        set_index: 0,
      });

      const { repo } = makeRepository([precedingRow, pullUpRow]);
      const orders = await repo.getExerciseOrders(90);

      const pullUpKey = strengthExerciseIdentityKey({
        exerciseName: "Weighted Pull Up",
        equipment: null,
      });
      const order = orders.get(pullUpKey);
      expect(order).toBeDefined();
      expect(order?.evidence).toEqual({
        source: "Crimpd",
        baseline: {
          activityId: "11111111-1111-4111-8111-111111111111",
          date: "2026-05-01",
          position: 2,
          sets: [{ position: 1, resistance: 20, unit: "KG", reps: 5 }],
        },
        earlier: null,
      });
    });

    it("returns earlier comparable session side by side when performed earlier than prior baseline", async () => {
      // Session 1: Workout on 2026-05-01, Pull Up at position 2 preceded by Bench Press at position 1 (baseline)
      const session1Bench = makeRow({
        canonical_activity_id: "act-1",
        workout_date: "2026-05-01",
        started_at: "2026-05-01T10:00:00Z",
        member_external_id: "ext-1",
        exercise_name: "Bench Press",
        exercise_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "80",
          WEIGHT_UNIT: "KG",
          REPS: "5",
        },
      });
      const session1PullUp = makeRow({
        canonical_activity_id: "act-1",
        workout_date: "2026-05-01",
        started_at: "2026-05-01T10:00:00Z",
        member_external_id: "ext-1",
        exercise_name: "Weighted Pull Up",
        exercise_index: 1,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
          REPS: "5",
        },
      });

      // Session 2: Workout on 2026-06-01, Pull Up at position 1 (first!) with same unit KG
      const session2PullUp = makeRow({
        canonical_activity_id: "act-2",
        workout_date: "2026-06-01",
        started_at: "2026-06-01T10:00:00Z",
        member_external_id: "ext-2",
        exercise_name: "Weighted Pull Up",
        exercise_index: 0,
        raw: {
          LOG_ID: "ext-2",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "25",
          WEIGHT_UNIT: "KG",
          REPS: "5",
        },
      });

      const { repo } = makeRepository([session1Bench, session1PullUp, session2PullUp]);
      const orders = await repo.getExerciseOrders(90);

      const pullUpKey = strengthExerciseIdentityKey({
        exerciseName: "Weighted Pull Up",
        equipment: null,
      });
      const order = orders.get(pullUpKey);
      expect(order?.evidence).toEqual({
        source: "Crimpd",
        baseline: {
          activityId: "act-1",
          date: "2026-05-01",
          position: 2,
          sets: [{ position: 1, resistance: 20, unit: "KG", reps: 5 }],
        },
        earlier: {
          activityId: "act-2",
          date: "2026-06-01",
          position: 1,
          sets: [{ position: 1, resistance: 25, unit: "KG", reps: 5 }],
        },
      });
    });

    it("rejects non-exact or junk positions like '2junk' and boolean true", async () => {
      const junkActivityOrder = makeRow({
        exercise_index: 1,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2junk",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });
      const booleanSetOrder = makeRow({
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: true,
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([junkActivityOrder, booleanSetOrder]);
      const orders = await repo.getExerciseOrders(90);
      expect(orders.size).toBe(0);
    });

    it("guards each exercise position against conflicting exercise identities", async () => {
      // Row 1: Position 1 set 1 is Bench Press
      const benchRow = makeRow({
        exercise_name: "Bench Press",
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "80",
          WEIGHT_UNIT: "KG",
        },
      });
      // Row 2: Corrupted data has Incline Press at the same position 1 set 2
      const corruptRow = makeRow({
        exercise_name: "Incline Press",
        exercise_index: 0,
        set_index: 1,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "2",
          COMPLETE: "true",
          RESISTANCE: "60",
          WEIGHT_UNIT: "KG",
        },
      });
      // Row 3: Position 2 is Pull Up
      const pullUpRow = makeRow({
        exercise_name: "Weighted Pull Up",
        exercise_index: 1,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([benchRow, corruptRow, pullUpRow]);
      const orders = await repo.getExerciseOrders(90);

      // The corrupt position cannot establish a baseline, so Pull Up has no valid preceding baseline
      const pullUpKey = strengthExerciseIdentityKey({
        exerciseName: "Weighted Pull Up",
        equipment: null,
      });
      expect(orders.has(pullUpKey)).toBe(false);
    });

    it("skips incomplete sets while retaining valid completed sets for the session", async () => {
      const benchRow = makeRow({
        exercise_name: "Bench Press",
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "80",
          WEIGHT_UNIT: "KG",
        },
      });
      // Pull Up set 1: valid
      const pullUpSet1 = makeRow({
        exercise_name: "Weighted Pull Up",
        exercise_index: 1,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });
      // Pull Up set 2: incomplete (COMPLETE=false), should be skipped without suppressing set 1
      const pullUpSet2 = makeRow({
        exercise_name: "Weighted Pull Up",
        exercise_index: 1,
        set_index: 1,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "2",
          COMPLETE: "false",
          RESISTANCE: "25",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([benchRow, pullUpSet1, pullUpSet2]);
      const orders = await repo.getExerciseOrders(90);

      const pullUpKey = strengthExerciseIdentityKey({
        exerciseName: "Weighted Pull Up",
        equipment: null,
      });
      const order = orders.get(pullUpKey);
      expect(order).toBeDefined();
      expect(order?.evidence.baseline.sets).toEqual([
        { position: 1, resistance: 20, unit: "KG", reps: 5 },
      ]);
    });

    it("rejects workouts with duplicate/repeated occurrences of the same exercise", async () => {
      const pullUp1 = makeRow({
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });
      const otherEx = makeRow({
        exercise_name: "Dip",
        exercise_index: 1,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "10",
          WEIGHT_UNIT: "KG",
        },
      });
      const pullUp2 = makeRow({
        exercise_index: 2,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "3",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([pullUp1, otherEx, pullUp2]);
      const orders = await repo.getExerciseOrders(90);

      const pullUpKey = strengthExerciseIdentityKey({
        exerciseName: "Weighted Pull Up",
        equipment: null,
      });
      expect(orders.has(pullUpKey)).toBe(false);
    });

    it("suppresses a repeated lift when one occurrence lacks loaded completed sets", async () => {
      const bench = makeRow({
        exercise_name: "Bench Press",
        equipment: "barbell",
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "60",
          WEIGHT_UNIT: "KG",
        },
      });
      const pullUpLoaded = makeRow({
        exercise_index: 1,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });
      const pullUpUnloaded = makeRow({
        exercise_index: 2,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "3",
          SET_ORDER: "1",
          COMPLETE: "false",
          RESISTANCE: "",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([bench, pullUpLoaded, pullUpUnloaded]);
      const orders = await repo.getExerciseOrders(90);

      expect(
        orders.has(
          strengthExerciseIdentityKey({ exerciseName: "Weighted Pull Up", equipment: null }),
        ),
      ).toBe(false);
    });

    it("rejects non-integer reps from otherwise loaded completed sets", async () => {
      const bench = makeRow({
        exercise_name: "Bench Press",
        equipment: "barbell",
        exercise_index: 0,
        set_index: 0,
        reps: 5.5,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "60",
          WEIGHT_UNIT: "KG",
        },
      });
      const pullUp = makeRow({
        exercise_index: 1,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([bench, pullUp]);
      const orders = await repo.getExerciseOrders(90);

      expect(orders.size).toBe(0);
    });

    it("accepts Crimpd decimal text forms '.5' and '5.' for loaded resistance", async () => {
      const bench = makeRow({
        exercise_name: "Bench Press",
        equipment: "barbell",
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: ".5",
          WEIGHT_UNIT: "KG",
        },
      });
      const pullUp = makeRow({
        exercise_index: 1,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "5.",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([bench, pullUp]);
      const orders = await repo.getExerciseOrders(90);

      const pullUpOrder = orders.get(
        strengthExerciseIdentityKey({ exerciseName: "Weighted Pull Up", equipment: null }),
      );
      expect(pullUpOrder?.evidence.baseline.sets).toEqual([
        { position: 1, resistance: 5, unit: "KG", reps: 5 },
      ]);
    });

    it("produces no evidence when lift is already first with no prior baseline", async () => {
      const pullUpFirst = makeRow({
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([pullUpFirst]);
      const orders = await repo.getExerciseOrders(90);
      expect(orders.size).toBe(0);
    });

    it("does not compare sessions with different recorded weight units", async () => {
      const session1Bench = makeRow({
        canonical_activity_id: "act-1",
        started_at: "2026-05-01T10:00:00Z",
        exercise_name: "Bench Press",
        exercise_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "80",
          WEIGHT_UNIT: "KG",
        },
      });
      const session1PullUp = makeRow({
        canonical_activity_id: "act-1",
        started_at: "2026-05-01T10:00:00Z",
        exercise_name: "Weighted Pull Up",
        exercise_index: 1,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "2",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });

      const session2PullUp = makeRow({
        canonical_activity_id: "act-2",
        started_at: "2026-06-01T10:00:00Z",
        member_external_id: "ext-2",
        exercise_name: "Weighted Pull Up",
        exercise_index: 0,
        raw: {
          LOG_ID: "ext-2",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "45",
          WEIGHT_UNIT: "LBS",
        },
      });

      const { repo } = makeRepository([session1Bench, session1PullUp, session2PullUp]);
      const orders = await repo.getExerciseOrders(90);

      const pullUpKey = strengthExerciseIdentityKey({
        exerciseName: "Weighted Pull Up",
        equipment: null,
      });
      expect(orders.has(pullUpKey)).toBe(false);
    });

    it("rejects conflicting same-source set positions", async () => {
      const set1 = makeRow({
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "20",
          WEIGHT_UNIT: "KG",
        },
      });
      const duplicateSet1 = makeRow({
        exercise_index: 0,
        set_index: 0,
        raw: {
          LOG_ID: "ext-1",
          ACTIVITY_ORDER: "1",
          SET_ORDER: "1",
          COMPLETE: "true",
          RESISTANCE: "25",
          WEIGHT_UNIT: "KG",
        },
      });

      const { repo } = makeRepository([set1, duplicateSet1]);
      const orders = await repo.getExerciseOrders(90);
      expect(orders.size).toBe(0);
    });
  });
});
