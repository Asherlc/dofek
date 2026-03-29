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
    });
  });

  it("toDetail() handles null notes", () => {
    const session = new BreathworkSession({ ...sampleRow, notes: null });
    expect(session.toDetail().notes).toBeNull();
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
      });
      expect(session).toBeInstanceOf(BreathworkSession);
      expect(session?.toDetail().techniqueId).toBe("wim-hof");
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
});
