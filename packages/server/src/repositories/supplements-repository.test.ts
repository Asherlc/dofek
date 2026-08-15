import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SupplementsRepository,
  supplementSchema,
  toApiSupplement,
} from "./supplements-repository.ts";

const NULL_NUTRIENTS: Record<string, null> = {
  calories: null,
  protein_g: null,
  carbs_g: null,
  fat_g: null,
  saturated_fat_g: null,
  polyunsaturated_fat_g: null,
  monounsaturated_fat_g: null,
  trans_fat_g: null,
  cholesterol_mg: null,
  sodium_mg: null,
  potassium_mg: null,
  fiber_g: null,
  sugar_g: null,
  vitamin_a_mcg: null,
  vitamin_c_mg: null,
  vitamin_d_mcg: null,
  vitamin_e_mg: null,
  vitamin_k_mcg: null,
  vitamin_b1_mg: null,
  vitamin_b2_mg: null,
  vitamin_b3_mg: null,
  vitamin_b5_mg: null,
  vitamin_b6_mg: null,
  vitamin_b7_mcg: null,
  vitamin_b9_mcg: null,
  vitamin_b12_mcg: null,
  calcium_mg: null,
  iron_mg: null,
  magnesium_mg: null,
  zinc_mg: null,
  selenium_mcg: null,
  copper_mg: null,
  manganese_mg: null,
  chromium_mcg: null,
  iodine_mcg: null,
  omega3_mg: null,
  omega6_mg: null,
  caffeine_mg: null,
  water_ml: null,
};

describe("toApiSupplement", () => {
  it("maps basic and nutrient fields to the API shape", () => {
    expect(
      toApiSupplement({
        definition_id: "definition-fish-oil",
        name: "Fish Oil",
        amount: 1000,
        unit: "mg",
        form: "softgel",
        description: "Daily omega-3",
        meal: "breakfast",
        ...NULL_NUTRIENTS,
        omega3_mg: 500,
      }),
    ).toEqual({
      id: "definition-fish-oil",
      name: "Fish Oil",
      amount: 1000,
      unit: "mg",
      form: "softgel",
      description: "Daily omega-3",
      meal: "breakfast",
      omega3Mg: 500,
    });
  });

  it("omits null optional and nutrient fields", () => {
    expect(
      toApiSupplement({
        definition_id: "definition-magnesium",
        name: "Magnesium",
        amount: null,
        unit: null,
        form: null,
        description: null,
        meal: null,
        ...NULL_NUTRIENTS,
      }),
    ).toEqual({ id: "definition-magnesium", name: "Magnesium" });
  });
});

describe("SupplementsRepository", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("list returns empty array when no data", async () => {
    const repository = makeRepository([]).repository;
    await expect(repository.list()).resolves.toEqual([]);
  });

  it("list returns parsed supplements", async () => {
    const repository = makeRepository([
      makeSupplementViewRow({
        name: "Vitamin D",
        amount: 5000,
        unit: "IU",
        form: "softgel",
        meal: "breakfast",
      }),
    ]).repository;

    await expect(repository.list()).resolves.toEqual([
      {
        id: "definition-1",
        name: "Vitamin D",
        amount: 5000,
        unit: "IU",
        form: "softgel",
        meal: "breakfast",
      },
    ]);
  });

  it("computes an inclusive occurrence window and selects only the current leaf", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-27T12:00:00.000Z") });
    const { repository, execute } = makeRepository([
      makeDoseEventRow({ id: "old-event", status: "taken", is_current: false }),
      makeDoseEventRow({
        id: "current-event",
        status: "skipped",
        supersedes_event_id: "old-event",
        is_current: true,
      }),
      makeDoseEventRow({
        id: "orphan-history",
        schedule_id: "schedule-2",
        supplement_id: "definition-2",
        supplement_name: "Magnesium",
        scheduled_date: "2026-07-26",
        is_current: false,
      }),
    ]);

    await expect(repository.occurrences(7)).resolves.toEqual({
      counts: { planned: 0, taken: 0, skipped: 1, unknown: 0 },
      occurrences: [
        {
          currentEventId: "current-event",
          scheduleId: "schedule-1",
          supplementId: "definition-1",
          supplementName: "Vitamin D",
          scheduledDate: "2026-07-27",
          status: "skipped",
          history: [
            {
              id: "old-event",
              providerId: "auto-supplements",
              status: "taken",
              recordedAt: "2026-07-27T08:00:00.000Z",
              sourceName: "Auto-Supplements",
            },
            {
              id: "current-event",
              providerId: "auto-supplements",
              status: "skipped",
              recordedAt: "2026-07-27T08:00:00.000Z",
              sourceName: "Auto-Supplements",
            },
          ],
        },
      ],
    });
    const query = JSON.stringify(execute.mock.calls[0]);
    expect(query).toContain("2026-07-21");
    expect(query).toContain("2026-07-27");
  });

  it.each([
    { id: "", name: "Vitamin D" },
    { name: "" },
    { name: "x".repeat(201) },
    { name: "Vitamin D", amount: 0 },
    { name: "Vitamin D", unit: "micrograms+" },
    { name: "Vitamin D", meal: "midnight" },
  ])("rejects invalid supplement input at the schema boundary: %o", (invalid) => {
    expect(supplementSchema.safeParse({ id: "definition-1", ...invalid }).success).toBe(false);
  });

  it("rejects an invalid supplement view row at the database boundary", async () => {
    const row = makeSupplementViewRow();
    row.definition_id = undefined;
    const repository = makeRepository([row]).repository;
    await expect(repository.list()).rejects.toThrow();
  });
});

function makeRepository(rows: Record<string, unknown>[]): {
  repository: SupplementsRepository;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue(rows);
  return {
    repository: new SupplementsRepository({ execute }, "user-1", "UTC"),
    execute,
  };
}

function makeSupplementViewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    definition_id: "definition-1",
    supplement_id: "schedule-1",
    user_id: "user-1",
    schedule_id: "schedule-1",
    supersedes_definition_id: null,
    name: "Vitamin D",
    amount: null,
    unit: null,
    form: null,
    description: null,
    meal: null,
    sort_order: 0,
    effective_from: "2026-01-01",
    effective_to: null,
    nutrition_data_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...NULL_NUTRIENTS,
    ...overrides,
  };
}

function makeDoseEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1",
    schedule_id: "schedule-1",
    supplement_id: "definition-1",
    supplement_name: "Vitamin D",
    scheduled_date: "2026-07-27",
    status: "planned",
    supersedes_event_id: null,
    provider_id: "auto-supplements",
    source_name: "Auto-Supplements",
    recorded_at: "2026-07-27T08:00:00.000Z",
    created_at: "2026-07-27T08:00:00.000Z",
    is_current: true,
    ...overrides,
  };
}
