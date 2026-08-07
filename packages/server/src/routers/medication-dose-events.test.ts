import { describe, expect, it, vi } from "vitest";
import { medicationDoseEventsRouter } from "./medication-dose-events.ts";
import { collectSqlText, createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(medicationDoseEventsRouter);

describe("medicationDoseEventsRouter", () => {
  it("lists dose events for the current user only", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "event-1",
                  providerId: "apple_health",
                  medicationName: "Metformin 500 mg",
                  medicationConceptId: "rxnorm-123",
                  doseStatus: "taken",
                  recordedAt: new Date("2026-06-29T15:30:00.000Z"),
                  sourceName: "Apple Health",
                },
              ]),
            })),
          })),
        })),
      })),
    };
    const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

    const result = await caller.list({ limit: 25 });

    expect(Object.keys(db.select.mock.calls[0]?.[0] ?? {})).toEqual([
      "id",
      "providerId",
      "medicationName",
      "medicationConceptId",
      "doseStatus",
      "recordedAt",
      "sourceName",
    ]);
    expect(result.events).toEqual([
      {
        id: "event-1",
        providerId: "apple_health",
        medicationName: "Metformin 500 mg",
        medicationConceptId: "rxnorm-123",
        doseStatus: "taken",
        recordedAt: "2026-06-29T15:30:00.000Z",
        sourceName: "Apple Health",
      },
    ]);
  });

  it("rejects malformed database rows at the router boundary", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "event-1",
                  providerId: 42,
                  medicationName: "Metformin 500 mg",
                  medicationConceptId: "rxnorm-123",
                  doseStatus: "taken",
                  recordedAt: new Date("2026-06-29T15:30:00.000Z"),
                  sourceName: "Apple Health",
                },
              ]),
            })),
          })),
        })),
      })),
    };
    const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

    await expect(caller.list({ limit: 25 })).rejects.toThrow();
  });

  it("normalizes database timestamp strings at the router boundary", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "event-1",
                  providerId: "apple_health",
                  medicationName: "Metformin 500 mg",
                  medicationConceptId: "rxnorm-123",
                  doseStatus: "taken",
                  recordedAt: "2026-06-29 15:30:00+00",
                  sourceName: "Apple Health",
                },
              ]),
            })),
          })),
        })),
      })),
    };
    const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

    const result = await caller.list({ limit: 25 });

    expect(result.events[0]?.recordedAt).toBe("2026-06-29T15:30:00.000Z");
  });

  it("scopes dose events to limited access windows", async () => {
    const where = vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([]),
      })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };
    const caller = createCaller({
      db,
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-06-01",
        endDateExclusive: "2026-06-08",
      },
    });

    await caller.list({ limit: 25 });

    const whereSql = collectSqlText(where.mock.calls[0]?.[0]);
    expect(whereSql).toContain(">=");
    expect(whereSql).toContain("<");
  });

  it("does not apply dose date bounds for full access windows", async () => {
    const where = vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([]),
      })),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };
    const caller = createCaller({
      db,
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full", paid: true, reason: "paid_grant" },
    });

    await caller.list({ limit: 25 });

    const whereSql = collectSqlText(where.mock.calls[0]?.[0]);
    expect(whereSql).not.toContain(">=");
    expect(whereSql).not.toContain("<");
  });
});
