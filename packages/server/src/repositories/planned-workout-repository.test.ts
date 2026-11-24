import { describe, expect, it, vi } from "vitest";
import { PlannedWorkoutRepository, projectWorkoutSteps } from "./planned-workout-repository.ts";

describe("projectWorkoutSteps", () => {
  it("bounds deep nesting and never emits raw vendor JSON", () => {
    let nested: Record<string, unknown> = { reps: 1, steps: [{ mystery: "secret" }] };
    for (let i = 0; i < 30; i++) nested = { reps: 1, steps: [nested] };

    const steps = projectWorkoutSteps({ steps: [nested] });

    expect(JSON.stringify(steps)).not.toContain("secret");
    expect(steps.length).toBeLessThanOrEqual(2);
  });

  it("bounds a wide document to one overflow marker without leaking source fields", () => {
    const steps = projectWorkoutSteps({
      steps: Array.from({ length: 600 }, (_, index) => ({ mystery: `secret-${index}` })),
    });

    expect(steps).toHaveLength(501);
    expect(JSON.stringify(steps)).not.toContain("secret");
  });

  it("projects authored targets of every type with values, ranges, and units", () => {
    const steps = projectWorkoutSteps({
      steps: [
        {
          text: "Ramp",
          duration: 600,
          distance: 5000,
          power: { value: 250, units: "W" },
          hr: { start: 120, end: 150 },
          pace: { value: 300 },
          cadence: { value: 90 },
        },
      ],
    });

    expect(steps).toEqual([
      {
        kind: "step",
        text: "Ramp",
        durationSeconds: 600,
        distanceMeters: 5000,
        targets: [
          { type: "power", value: 250, start: null, end: null, unit: "W" },
          { type: "heart_rate", value: null, start: 120, end: 150, unit: null },
          { type: "pace", value: 300, start: null, end: null, unit: null },
          { type: "cadence", value: 90, start: null, end: null, unit: null },
        ],
      },
    ]);
  });

  it("skips invalid target shapes, all-nullish targets, and non-finite authored values", () => {
    const steps = projectWorkoutSteps({
      steps: [
        { power: "not-an-object", hr: {} },
        { power: { value: Number.NaN }, hr: { value: Number.POSITIVE_INFINITY } },
        { cadence: { value: 0 } },
      ],
    });

    expect(steps).toEqual([
      { kind: "unsupported" },
      { kind: "unsupported" },
      {
        kind: "step",
        text: null,
        durationSeconds: null,
        distanceMeters: null,
        targets: [{ type: "cadence", value: 0, start: null, end: null, unit: null }],
      },
    ]);
  });

  it("normalizes blank text, non-string text, and non-finite numbers to null", () => {
    const steps = projectWorkoutSteps({
      steps: [
        { text: "   ", duration: Number.NaN, distance: Number.POSITIVE_INFINITY },
        { text: 42, duration: "600", distance: null },
        { text: "Keep", duration: 0, distance: 0 },
      ],
    });

    expect(steps).toEqual([
      { kind: "unsupported" },
      { kind: "unsupported" },
      {
        kind: "step",
        text: "Keep",
        durationSeconds: 0,
        distanceMeters: 0,
        targets: [],
      },
    ]);
  });

  it("skips nullish nodes and marks non-object nodes unsupported", () => {
    const steps = projectWorkoutSteps({
      steps: [null, undefined, 42, "text-node", [], { text: "ok" }],
    });

    expect(steps).toEqual([
      { kind: "unsupported" },
      { kind: "unsupported" },
      { kind: "unsupported" },
      { kind: "step", text: "ok", durationSeconds: null, distanceMeters: null, targets: [] },
    ]);
  });

  it("projects repeat nodes with nested steps and keeps a reps node without steps as a step", () => {
    const steps = projectWorkoutSteps({
      steps: [
        { text: "Repeat", reps: 3, steps: [{ text: "Inner", duration: 60 }] },
        { text: "Reps only", reps: 4 },
        { reps: 0, steps: [] },
      ],
    });

    expect(steps).toEqual([
      {
        kind: "repeat",
        repetitions: 3,
        text: "Repeat",
        steps: [
          { kind: "step", text: "Inner", durationSeconds: 60, distanceMeters: null, targets: [] },
        ],
      },
      { kind: "step", text: "Reps only", durationSeconds: null, distanceMeters: null, targets: [] },
      { kind: "repeat", repetitions: 0, text: null, steps: [] },
    ]);
  });

  it("returns nothing for documents without a steps array", () => {
    expect(projectWorkoutSteps(null)).toEqual([]);
    expect(projectWorkoutSteps({})).toEqual([]);
    expect(projectWorkoutSteps({ steps: "not-an-array" })).toEqual([]);
    expect(projectWorkoutSteps([])).toEqual([]);
  });
});

describe("planned workout schemas (fresh module)", () => {
  it("validates targets, steps, and a full day through the exported schemas", async () => {
    vi.resetModules();
    const {
      plannedWorkoutTargetSchema: target,
      plannedWorkoutStepSchema: step,
      plannedWorkoutDaySchema: day,
    } = await import("./planned-workout-repository.ts");

    expect(
      target.parse({ type: "power", value: 250, start: null, end: null, unit: "W" }),
    ).toMatchObject({ type: "power", value: 250 });
    expect(() => target.parse({ type: "unknown", value: 1 })).toThrow();

    expect(step.parse({ kind: "unsupported" })).toEqual({ kind: "unsupported" });
    expect(
      step.parse({
        kind: "repeat",
        repetitions: 2,
        text: null,
        steps: [{ kind: "unsupported" }],
      }),
    ).toMatchObject({ kind: "repeat", repetitions: 2 });
    expect(() => step.parse({ kind: "mystery" })).toThrow();

    expect(
      day.parse({
        date: "2026-03-10",
        workouts: [
          {
            id: "w1",
            providerId: "intervals.icu",
            title: null,
            description: null,
            sportType: null,
            startTime: null,
            steps: [{ kind: "unsupported" }],
          },
        ],
      }),
    ).toMatchObject({ date: "2026-03-10" });
  });
});

describe("PlannedWorkoutRepository.upcoming", () => {
  it("groups rows by day and projects each workout's steps", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        id: "w1",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: "06:30",
        title: "Session",
        description: "notes",
        sport_type: "Ride",
        workout_doc: { steps: [{ duration: 600 }] },
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
      {
        id: "w2",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: null,
        title: null,
        description: null,
        sport_type: null,
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
      {
        id: "w3",
        provider_id: "intervals.icu",
        start_date: "2026-03-11",
        start_time: null,
        title: null,
        description: null,
        sport_type: null,
        workout_doc: { steps: [{ kind: "unsupported" }] },
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
    ]);

    const repo = new PlannedWorkoutRepository({ execute }, "user-1", "2026-03-10", "intervals.icu");

    expect(await repo.upcoming()).toEqual([
      {
        date: "2026-03-10",
        workouts: [
          {
            id: "w1",
            providerId: "intervals.icu",
            title: "Session",
            description: "notes",
            sportType: "Ride",
            startTime: "06:30",
            steps: [
              {
                kind: "step",
                text: null,
                durationSeconds: 600,
                distanceMeters: null,
                targets: [],
              },
            ],
          },
          {
            id: "w2",
            providerId: "intervals.icu",
            title: null,
            description: null,
            sportType: null,
            startTime: null,
            steps: [],
          },
        ],
      },
      {
        date: "2026-03-11",
        workouts: [
          {
            id: "w3",
            providerId: "intervals.icu",
            title: null,
            description: null,
            sportType: null,
            startTime: null,
            steps: [{ kind: "unsupported" }],
          },
        ],
      },
    ]);
  });

  it("reads an explicit inclusive date range and filters by canonical sport mapping", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        id: "ride",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: "06:30",
        title: "Ride",
        description: null,
        sport_type: "Ride",
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
      {
        id: "run",
        provider_id: "intervals.icu",
        start_date: "2026-03-11",
        start_time: null,
        title: "Run",
        description: null,
        sport_type: "Run",
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
    ]);
    const repo = new PlannedWorkoutRepository({ execute }, "user-1", "2026-03-10");
    const days = await repo.upcoming({
      dateRange: { startDate: "2026-03-10", endDate: "2026-03-20" },
      activityType: "cycling",
    });
    expect(days).toEqual([
      {
        date: "2026-03-10",
        workouts: [
          expect.objectContaining({
            id: "ride",
            sportType: "Ride",
          }),
        ],
      },
    ]);
    const sql = String(execute.mock.calls[0]?.[0]?.queryChunks ?? execute.mock.calls[0]?.[0]);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("2026-03-10");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("2026-03-20");
    expect(sql).not.toContain("secret");
  });

  it("marks Intervals.icu rows as snapshots when the OAuth grant lacks CALENDAR:READ", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        id: "live",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: null,
        title: "Live",
        description: null,
        sport_type: "Ride",
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
      {
        id: "snap",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: null,
        title: "Snapshot",
        description: null,
        sport_type: "Ride",
        workout_doc: null,
        updated_at: "2026-02-15T08:30:00.000Z",
        provider_connected: false,
      },
    ]);
    const days = await new PlannedWorkoutRepository({ execute }, "user-1", "2026-03-10").upcoming();
    expect(days[0]?.workouts).toEqual([
      expect.objectContaining({ id: "live" }),
      expect.objectContaining({
        id: "snap",
        snapshotImportedAt: "2026-02-15T08:30:00.000Z",
      }),
    ]);
    const sql = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(sql).toContain("oauth_token");
    expect(sql).toContain("CALENDAR:READ");
    expect(sql).not.toContain("access_token");
  });

  it("skips whitespace-only sport types when filtering instead of throwing", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        id: "blank",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: null,
        title: "Blank sport",
        description: null,
        sport_type: "   ",
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
      {
        id: "ride",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: null,
        title: "Ride",
        description: null,
        sport_type: "Ride",
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
    ]);
    await expect(
      new PlannedWorkoutRepository({ execute }, "user-1", "2026-03-10").upcoming({
        activityType: "cycling",
      }),
    ).resolves.toEqual([
      {
        date: "2026-03-10",
        workouts: [expect.objectContaining({ id: "ride" })],
      },
    ]);
  });

  it("attaches snapshotImportedAt only for disconnected provider rows", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        id: "live",
        provider_id: "intervals.icu",
        start_date: "2026-03-10",
        start_time: null,
        title: "Live",
        description: null,
        sport_type: "Ride",
        workout_doc: null,
        updated_at: "2026-03-01T12:00:00.000Z",
        provider_connected: true,
      },
      {
        id: "snap",
        provider_id: "trainerroad",
        start_date: "2026-03-10",
        start_time: null,
        title: "Snapshot",
        description: null,
        sport_type: "Ride",
        workout_doc: null,
        updated_at: "2026-02-15T08:30:00.000Z",
        provider_connected: false,
      },
    ]);
    const days = await new PlannedWorkoutRepository({ execute }, "user-1", "2026-03-10").upcoming();
    expect(days[0]?.workouts).toEqual([
      expect.objectContaining({ id: "live" }),
      expect.objectContaining({
        id: "snap",
        snapshotImportedAt: "2026-02-15T08:30:00.000Z",
      }),
    ]);
    expect(days[0]?.workouts[0]).not.toHaveProperty("snapshotImportedAt");
  });
});
