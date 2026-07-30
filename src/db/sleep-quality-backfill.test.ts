import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeWithSchema: vi.fn() }));

vi.mock("../lib/typed-sql.ts", () => ({ executeWithSchema: mocks.executeWithSchema }));

import { backfillSleepQuality } from "./sleep-quality-backfill.ts";

const database = { execute: vi.fn() };
const options = {
  execute: false,
  start: new Date("2026-07-01T00:00:00Z"),
  end: new Date("2026-08-01T00:00:00Z"),
};

describe("backfillSleepQuality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])("maps the single %s execution result", async (execute) => {
    mocks.executeWithSchema.mockResolvedValue([
      {
        rows_changed: 5,
        staging_marked_available: 2,
        stage_values_cleared: 3,
        apple_efficiency_cleared: 4,
      },
    ]);

    await expect(backfillSleepQuality(database, { ...options, execute })).resolves.toEqual({
      rowsChanged: 5,
      stagingMarkedAvailable: 2,
      stageValuesCleared: 3,
      appleEfficiencyCleared: 4,
    });
    expect(mocks.executeWithSchema).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "no rows", rows: [] },
    { label: "multiple rows", rows: [{}, {}] },
  ])("rejects $label", async ({ rows }) => {
    mocks.executeWithSchema.mockResolvedValue(rows);

    await expect(backfillSleepQuality(database, options)).rejects.toThrow(
      "Expected one sleep quality backfill result row",
    );
  });
});
