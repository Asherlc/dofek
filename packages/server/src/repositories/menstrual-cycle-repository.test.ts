import { describe, expect, it, vi } from "vitest";
import { MenstrualCycleRepository } from "./menstrual-cycle-repository.ts";

function eventRow(
  localDate: string,
  providerId = "apple_health",
  sourceName: string | null = "Cycle Source",
  sourceBundle: string | null = "com.example.cycle",
) {
  return {
    local_date: localDate,
    provider_id: providerId,
    source_name: sourceName,
    source_bundle: sourceBundle,
  };
}

function makeRepository(rows: Record<string, unknown>[]) {
  const execute = vi.fn().mockResolvedValue(rows);
  return {
    execute,
    repository: new MenstrualCycleRepository(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      "America/Los_Angeles",
    ),
  };
}

describe("MenstrualCycleRepository", () => {
  it("groups exact-date provider records and sorts their source attribution", async () => {
    const { repository } = makeRepository([
      eventRow("2026-07-01", "garmin", null, "com.garmin.connect"),
      eventRow("2026-07-01", "apple_health", "Cycle Source", "com.example.cycle"),
      eventRow("2026-07-29"),
    ]);

    await expect(repository.getHistory(6, new Date("2026-08-14T12:00:00Z"))).resolves.toEqual([
      {
        id: "cycle-start:2026-07-01",
        startDate: "2026-07-01",
        sources: [
          {
            providerId: "apple_health",
            sourceName: "Cycle Source",
            sourceBundle: "com.example.cycle",
          },
          {
            providerId: "garmin",
            sourceName: null,
            sourceBundle: "com.garmin.connect",
          },
        ],
      },
      {
        id: "cycle-start:2026-07-29",
        startDate: "2026-07-29",
        sources: [
          {
            providerId: "apple_health",
            sourceName: "Cycle Source",
            sourceBundle: "com.example.cycle",
          },
        ],
      },
    ]);
  });

  it("returns a provider-record no-history state", async () => {
    const { repository } = makeRepository([]);
    const result = await repository.getCurrentPhase(new Date("2026-08-14T12:00:00Z"));

    expect(result).toMatchObject({
      phase: null,
      latestCycleStart: null,
      availability: { status: "no-history", label: expect.stringContaining("provider records") },
    });
  });

  it("estimates from three completed regular cycles", async () => {
    const { repository } = makeRepository([
      eventRow("2026-05-13"),
      eventRow("2026-06-10"),
      eventRow("2026-07-08"),
      eventRow("2026-08-05"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-08-14T12:00:00Z"));

    expect(result).toMatchObject({
      phase: "follicular",
      dayOfCycle: 10,
      cycleLength: 28,
      latestCycleStart: { id: "cycle-start:2026-08-05" },
      estimate: {
        completedCycleCount: 3,
        observedCycleLengthRange: { minimumDays: 28, maximumDays: 28 },
      },
      availability: { status: "estimated" },
    });
  });

  it("withholds an estimate for sparse history", async () => {
    const { repository } = makeRepository([
      eventRow("2026-07-01"),
      eventRow("2026-07-29"),
      eventRow("2026-08-26"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-08-30T12:00:00Z"));
    expect(result.availability.status).toBe("sparse-history");
    expect(result.phase).toBeNull();
  });

  it("withholds an estimate for irregular intervals", async () => {
    const { repository } = makeRepository([
      eventRow("2026-04-01"),
      eventRow("2026-05-07"),
      eventRow("2026-06-12"),
      eventRow("2026-07-18"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-07-20T12:00:00Z"));
    expect(result.availability.status).toBe("irregular-history");
    expect(result.phase).toBeNull();
  });

  it("reports conflicting distinct starts fewer than 21 days apart", async () => {
    const { repository } = makeRepository([
      eventRow("2026-06-01"),
      eventRow("2026-06-20", "garmin"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-06-25T12:00:00Z"));
    expect(result.availability).toEqual({
      status: "conflicting-history",
      label: expect.stringContaining("2026-06-01 and 2026-06-20"),
    });
    expect(result.phase).toBeNull();
  });

  it("withholds a stale estimate and directs correction to the source", async () => {
    const { repository } = makeRepository([
      eventRow("2026-03-01"),
      eventRow("2026-03-29"),
      eventRow("2026-04-26"),
      eventRow("2026-05-24"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-07-10T12:00:00Z"));
    expect(result.availability).toEqual({
      status: "stale-history",
      label: expect.stringContaining("source and sync again"),
    });
    expect(result.phase).toBeNull();
  });
});
