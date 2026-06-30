import { describe, expect, it, vi } from "vitest";
import { medicationDoseEventsRouter } from "./medication-dose-events.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

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
});
