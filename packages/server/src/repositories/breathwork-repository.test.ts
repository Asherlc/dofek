import { describe, expect, it, vi } from "vitest";
import { BreathworkRepository, BreathworkSession } from "./breathwork-repository.ts";

function makeDb(rows: Record<string, unknown>[] = []) {
  return { execute: vi.fn().mockResolvedValue(rows) };
}

const sampleRow = {
  id: "session-1",
  technique_id: "wim-hof",
  rounds: 3,
  duration_seconds: 600,
  started_at: "2025-06-15T08:30:00.000Z",
  notes: "Felt great",
  stress_before: 8,
  stress_after: 4,
  dizziness_after: false,
  perceived_effect: "better",
};

describe("BreathworkSession", () => {
  it("toDetail() maps snake_case row to camelCase detail", () => {
    const session = new BreathworkSession(sampleRow);
    expect(session.toDetail()).toEqual({
      id: "session-1",
      techniqueId: "wim-hof",
      rounds: 3,
      durationSeconds: 600,
      startedAt: "2025-06-15T08:30:00.000Z",
      notes: "Felt great",
      stressBefore: 8,
      stressAfter: 4,
      dizzinessAfter: false,
      perceivedEffect: "better",
    });
  });

  it("toDetail() distinguishes zero and false reports from missing reports", () => {
    const reported = new BreathworkSession({
      ...sampleRow,
      notes: null,
      stress_before: 0,
      stress_after: 0,
      dizziness_after: false,
      perceived_effect: "same",
    });
    const skipped = new BreathworkSession({
      ...sampleRow,
      notes: null,
      stress_before: null,
      stress_after: null,
      dizziness_after: null,
      perceived_effect: null,
    });

    expect(reported.toDetail()).toMatchObject({
      notes: null,
      stressBefore: 0,
      stressAfter: 0,
      dizzinessAfter: false,
      perceivedEffect: "same",
    });
    expect(skipped.toDetail()).toMatchObject({
      notes: null,
      stressBefore: null,
      stressAfter: null,
      dizzinessAfter: null,
      perceivedEffect: null,
    });
  });
});

describe("BreathworkRepository", () => {
  describe("logSession", () => {
    it("returns a BreathworkSession on success", async () => {
      const db = makeDb([sampleRow]);
      const repo = new BreathworkRepository(db, "user-1");
      const session = await repo.logSession({
        techniqueId: "wim-hof",
        rounds: 3,
        durationSeconds: 600,
        startedAt: "2025-06-15T08:30:00.000Z",
        notes: "Felt great",
        stressBefore: 8,
        stressAfter: 4,
        dizzinessAfter: false,
        perceivedEffect: "better",
      });
      expect(session).toBeInstanceOf(BreathworkSession);
      expect(session?.toDetail()).toMatchObject({
        techniqueId: "wim-hof",
        stressBefore: 8,
        stressAfter: 4,
        dizzinessAfter: false,
        perceivedEffect: "better",
      });
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it("returns null when no row is returned", async () => {
      const db = makeDb([]);
      const repo = new BreathworkRepository(db, "user-1");
      const session = await repo.logSession({
        techniqueId: "wim-hof",
        rounds: 3,
        durationSeconds: 600,
        startedAt: "2025-06-15T08:30:00.000Z",
        notes: null,
        stressBefore: null,
        stressAfter: null,
        dizzinessAfter: null,
        perceivedEffect: null,
      });
      expect(session).toBeNull();
    });
  });

  describe("getHistory", () => {
    it("returns array of BreathworkSession", async () => {
      const secondRow = {
        ...sampleRow,
        id: "session-2",
        started_at: "2025-06-14T09:00:00.000Z",
      };
      const db = makeDb([sampleRow, secondRow]);
      const repo = new BreathworkRepository(db, "user-1");
      const sessions = await repo.getHistory(30);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toBeInstanceOf(BreathworkSession);
      expect(sessions[1]?.toDetail().id).toBe("session-2");
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when no sessions exist", async () => {
      const db = makeDb([]);
      const repo = new BreathworkRepository(db, "user-1");
      const sessions = await repo.getHistory(30);
      expect(sessions).toEqual([]);
    });
  });

  describe("getOutcomeSummaries", () => {
    it("maps server-computed descriptive counts by technique", async () => {
      const db = makeDb([
        {
          technique_id: "box-breathing",
          session_count: 6,
          stress_pair_count: 4,
          lower_stress_count: 3,
          same_stress_count: 1,
          higher_stress_count: 0,
          perceived_effect_count: 5,
          better_count: 4,
          same_effect_count: 1,
          worse_count: 0,
          dizziness_report_count: 5,
          dizziness_count: 1,
        },
      ]);
      const repo = new BreathworkRepository(db, "user-1");

      await expect(repo.getOutcomeSummaries()).resolves.toEqual({
        windowDays: 30,
        windowKind: "rolling-instant",
        techniques: [
          {
            techniqueId: "box-breathing",
            sessionCount: 6,
            stress: { reportCount: 4, lowerCount: 3, sameCount: 1, higherCount: 0 },
            perceivedEffect: { reportCount: 5, betterCount: 4, sameCount: 1, worseCount: 0 },
            dizziness: { reportCount: 5, yesCount: 1 },
          },
        ],
      });
    });
  });
});
