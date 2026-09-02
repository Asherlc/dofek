import { PgDialect } from "drizzle-orm/pg-core";
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
      eventRow("2026-07-29"),
      eventRow("2026-07-01", "z-provider", null, "a.bundle"),
      eventRow("2026-07-01", "a-provider", "Alpha", "z.bundle"),
      eventRow("2026-07-01", "a-provider", "Zulu", "z.bundle"),
    ]);

    await expect(repository.getHistory(6, new Date("2026-08-14T12:00:00Z"))).resolves.toEqual([
      {
        id: "cycle-start:2026-07-01",
        startDate: "2026-07-01",
        sources: [
          {
            providerId: "a-provider",
            sourceName: "Alpha",
            sourceBundle: "z.bundle",
          },
          {
            providerId: "a-provider",
            sourceName: "Zulu",
            sourceBundle: "z.bundle",
          },
          {
            providerId: "z-provider",
            sourceName: null,
            sourceBundle: "a.bundle",
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

  it("sorts null source fields before populated fields in either input order", async () => {
    const nullSource = eventRow("2026-07-01", "apple_health", null, null);
    const populatedSource = eventRow(
      "2026-07-01",
      "apple_health",
      "Cycle Source",
      "com.example.cycle",
    );
    const expectedSources = [
      { providerId: "apple_health", sourceName: null, sourceBundle: null },
      {
        providerId: "apple_health",
        sourceName: "Cycle Source",
        sourceBundle: "com.example.cycle",
      },
    ];

    for (const rows of [
      [nullSource, populatedSource],
      [populatedSource, nullSource],
    ]) {
      const { repository } = makeRepository(rows);
      const history = await repository.getHistory(6, new Date("2026-08-14T12:00:00Z"));
      expect(history[0]?.sources).toEqual(expectedSources);
    }
  });

  it("sorts populated source names in either input order", async () => {
    const alpha = eventRow("2026-07-01", "apple_health", "Alpha", "com.example.cycle");
    const zulu = eventRow("2026-07-01", "apple_health", "Zulu", "com.example.cycle");

    for (const rows of [
      [alpha, zulu],
      [zulu, alpha],
    ]) {
      const { repository } = makeRepository(rows);
      const history = await repository.getHistory(6, new Date("2026-08-14T12:00:00Z"));
      expect(history[0]?.sources.map((source) => source.sourceName)).toEqual(["Alpha", "Zulu"]);
    }
  });

  it("uses local calendar boundaries and clamps month-end history ranges", async () => {
    const { repository, execute } = makeRepository([]);

    await repository.getHistory(1, new Date("2025-04-01T06:30:00Z"));

    const statement = execute.mock.calls[0]?.[0];
    expect(statement).toBeDefined();
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.params).toContain("2025-02-28");
    expect(query.params).toContain("2025-04-01");
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
        uncertaintyLabel: "All 3 recorded cycles were 28 days long.",
      },
      availability: { status: "estimated" },
    });
  });

  it("reports the observed range for varying regular cycles", async () => {
    const { repository } = makeRepository([
      eventRow("2026-05-01"),
      eventRow("2026-05-28"),
      eventRow("2026-06-27"),
      eventRow("2026-07-26"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-08-01T12:00:00Z"));

    expect(result).toMatchObject({
      cycleLength: 29,
      estimate: {
        observedCycleLengthRange: { minimumDays: 27, maximumDays: 30 },
        uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 30 days.",
      },
      availability: { status: "estimated" },
    });
  });

  it("accepts the 21-day minimum and nine-day variation boundary", async () => {
    const { repository } = makeRepository([
      eventRow("2026-01-01"),
      eventRow("2026-01-22"),
      eventRow("2026-02-21"),
      eventRow("2026-03-17"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-03-20T12:00:00Z"));

    expect(result.availability.status).toBe("estimated");
    expect(result.estimate?.observedCycleLengthRange).toEqual({
      minimumDays: 21,
      maximumDays: 30,
    });
  });

  it("accepts the 35-day maximum boundary", async () => {
    const { repository } = makeRepository([
      eventRow("2026-03-01"),
      eventRow("2026-04-05"),
      eventRow("2026-05-10"),
      eventRow("2026-06-14"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-06-18T12:00:00Z"));

    expect(result.availability.status).toBe("estimated");
    expect(result.cycleLength).toBe(35);
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

  it("withholds an estimate when regular-length cycles vary by ten days", async () => {
    const { repository } = makeRepository([
      eventRow("2026-01-01"),
      eventRow("2026-01-22"),
      eventRow("2026-02-22"),
      eventRow("2026-03-18"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-03-20T12:00:00Z"));

    expect(result.availability.status).toBe("irregular-history");
    expect(result.availability.label).toContain("21 to 31 days");
  });

  it("reports conflicting distinct starts fewer than 21 days apart", async () => {
    const { repository } = makeRepository([
      eventRow("2026-06-01"),
      eventRow("2026-06-20", "garmin"),
      eventRow("2026-07-15"),
    ]);

    const result = await repository.getCurrentPhase(new Date("2026-06-25T12:00:00Z"));
    expect(result.availability).toEqual({
      status: "conflicting-history",
      label: expect.stringContaining("2026-06-01 and 2026-06-20"),
    });
    expect(result.availability.label).not.toContain("2026-07-15");
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

  it("keeps an estimate through the stale-window boundary", async () => {
    const rows = [
      eventRow("2026-03-01"),
      eventRow("2026-03-29"),
      eventRow("2026-04-26"),
      eventRow("2026-05-24"),
    ];
    const boundary = await makeRepository(rows).repository.getCurrentPhase(
      new Date("2026-06-27T12:00:00Z"),
    );
    const stale = await makeRepository(rows).repository.getCurrentPhase(
      new Date("2026-06-28T12:00:00Z"),
    );

    expect(boundary.dayOfCycle).toBe(35);
    expect(boundary.availability.status).toBe("estimated");
    expect(stale.availability.status).toBe("stale-history");
  });
});
