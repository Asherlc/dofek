import { describe, expect, it } from "vitest";
import observedMealFixture from "./fixtures/observed-meal.sanitized.json" with { type: "json" };
import { normalizeZivaMeal, parseZivaMealPayload } from "./schemas.ts";

const EXPECTED_DATE = "2000-01-02";
const BASE_MEAL = observedMealFixture.meals[0];

if (!BASE_MEAL) {
  throw new Error("The sanitized observed-shape fixture must contain one meal");
}

function parsePayload(value: unknown = observedMealFixture) {
  return parseZivaMealPayload(structuredClone(value), { expectedDate: EXPECTED_DATE });
}

function firstParsedMeal(value: unknown = observedMealFixture) {
  const meal = parsePayload(value).meals[0];
  if (!meal) throw new Error("Expected one parsed Ziva meal");
  return meal;
}

function normalizeFirstMeal(
  value: unknown = observedMealFixture,
  identity: { sourceAccountKey: string } = {
    sourceAccountKey: "opaque-account-key-a",
  },
) {
  return normalizeZivaMeal(firstParsedMeal(value), identity);
}

describe("parseZivaMealPayload", () => {
  it("parses the sanitized authenticated observed shape without treating top-level metadata as meals", () => {
    const payload = parsePayload();

    expect(payload).toMatchObject({
      dailyTargets: observedMealFixture.dailyTargets,
      instructions: "Sanitized and ignored",
    });
    expect(payload.meals).toHaveLength(1);
    expect(payload.meals[0]).toEqual(BASE_MEAL);
  });

  it("accepts a valid empty diary result", () => {
    expect(parsePayload({ meals: [] })).toEqual({ meals: [] });
  });

  it.each(["2000-02-30", "2000-1-2", "not-a-date"])(
    "rejects invalid caller date %s",
    (expectedDate) => {
      expect(() => parseZivaMealPayload(observedMealFixture, { expectedDate })).toThrow();
    },
  );

  it.each(["2000-02-30", "2000-1-2", "not-a-date"])("rejects invalid meal date %s", (mealDate) => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [{ ...BASE_MEAL, mealDate }],
      }),
    ).toThrow();
  });

  it("rejects a meal from a different calendar date", () => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [{ ...BASE_MEAL, mealDate: "2000-01-03" }],
      }),
    ).toThrow();
  });

  it("rejects blank meal IDs", () => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [{ ...BASE_MEAL, mealId: "   " }],
      }),
    ).toThrow();
  });

  it("rejects duplicate meal IDs across the complete response", () => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [BASE_MEAL, { ...BASE_MEAL, description: "Duplicate ID" }],
      }),
    ).toThrow();
  });

  it.each([
    ["numeric strings", { ...BASE_MEAL.macros, calories: "321" }],
    ["negative values", { ...BASE_MEAL.macros, protein: -1 }],
    ["NaN", { ...BASE_MEAL.macros, carbs: Number.NaN }],
    ["infinity", { ...BASE_MEAL.macros, fat: Number.POSITIVE_INFINITY }],
  ])("rejects macros containing %s", (_case, macros) => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [{ ...BASE_MEAL, macros }],
      }),
    ).toThrow();
  });

  it.each(["protein", "fat", "carbs", "calories"] as const)(
    "rejects a meal missing the complete %s macro",
    (macroKey) => {
      const macros = { ...BASE_MEAL.macros };
      Reflect.deleteProperty(macros, macroKey);

      expect(() =>
        parsePayload({
          ...observedMealFixture,
          meals: [{ ...BASE_MEAL, macros }],
        }),
      ).toThrow();
    },
  );

  it.each(["protein", "fat", "carbs", "calories"] as const)(
    "rejects a null %s macro rather than authorizing replacement",
    (macroKey) => {
      expect(() =>
        parsePayload({
          ...observedMealFixture,
          meals: [
            {
              ...BASE_MEAL,
              macros: { ...BASE_MEAL.macros, [macroKey]: null },
            },
          ],
        }),
      ).toThrow();
    },
  );

  it.each([
    ["a non-array items value", { ...BASE_MEAL, items: { food: "Not an array" } }],
    ["a null item", { ...BASE_MEAL, items: [null] }],
    [
      "a blank consumed portion",
      {
        ...BASE_MEAL,
        items: [{ ...BASE_MEAL.items[0], portion: "   " }],
      },
    ],
  ])("rejects malformed item arrays containing %s", (_case, meal) => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [meal],
      }),
    ).toThrow();
  });

  it("rejects an itemCount that does not match the item array", () => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [{ ...BASE_MEAL, itemCount: 2 }],
      }),
    ).toThrow();
  });

  it.each([
    ["an impossible calendar date", "2000-02-30T03:04:05Z"],
    ["an impossible clock time", "2000-01-02T25:04:05Z"],
    ["an invalid timezone offset", "2000-01-02T03:04:05+25:00"],
    ["a date without a time", "2000-01-02"],
    ["arbitrary text", "created sometime"],
  ])("rejects createdAt containing %s", (_case, createdAt) => {
    expect(() =>
      parsePayload({
        ...observedMealFixture,
        meals: [{ ...BASE_MEAL, createdAt }],
      }),
    ).toThrow();
  });
});

describe("normalizeZivaMeal", () => {
  it("maps the observed singleton meal and serving fields without scaling whole-meal macros", () => {
    const normalized = normalizeFirstMeal();

    expect(normalized).toMatchObject({
      date: EXPECTED_DATE,
      meal: "snack",
      foodName: "Sanitized food",
      foodDescription: "Sanitized meal",
      numberOfUnits: 1,
      servingUnit: "Sanitized portion",
      servingWeightGrams: null,
    });
    expect(normalized.loggedAt?.toISOString()).toBe("2000-01-02T03:04:05.000Z");
    expect(normalized.nutrients).toEqual([
      { nutrientId: "calories", amount: 321 },
      { nutrientId: "protein", amount: 12 },
      { nutrientId: "carbohydrate", amount: 34 },
      { nutrientId: "fat", amount: 15 },
    ]);
    expect(normalized.raw).toEqual(BASE_MEAL);
  });

  it.each([
    ["breakfast", "breakfast"],
    ["LUNCH", "lunch"],
    ["Dinner", "dinner"],
    ["snack", "snack"],
    ["Second breakfast", "other"],
  ] as const)("normalizes meal type %s to %s", (mealType, expectedMeal) => {
    const normalized = normalizeFirstMeal({
      ...observedMealFixture,
      meals: [{ ...BASE_MEAL, mealType }],
    });

    expect(normalized.meal).toBe(expectedMeal);
  });

  it.each([
    ["2000-01-02T03:04:05Z", "2000-01-02T03:04:05.000Z"],
    ["2000-01-02T03:04:05-05:00", "2000-01-02T08:04:05.000Z"],
  ])("preserves an RFC 3339 timestamp with an explicit zone", (createdAt, expectedTimestamp) => {
    const normalized = normalizeFirstMeal({
      ...observedMealFixture,
      meals: [{ ...BASE_MEAL, createdAt }],
    });

    expect(normalized.loggedAt?.toISOString()).toBe(expectedTimestamp);
  });

  it("keeps a timezone-less createdAt in raw provenance without inventing loggedAt", () => {
    const normalized = normalizeFirstMeal({
      ...observedMealFixture,
      meals: [{ ...BASE_MEAL, createdAt: "2000-01-02T03:04:05" }],
    });

    expect(normalized.loggedAt).toBeNull();
    expect(normalized.raw).toMatchObject({ createdAt: "2000-01-02T03:04:05" });
  });

  it("keeps a synthetic multi-item response as one unscaled meal aggregate", () => {
    const syntheticMultiItemPayload = {
      meals: [
        {
          ...BASE_MEAL,
          mealId: "synthetic_multi_item",
          description: "Synthetic multi-item meal",
          items: [
            {
              food: "Synthetic food one",
              portion: "2 servings",
              gramWeight: 200,
              quantity: 2,
            },
            {
              food: "Synthetic food two",
              portion: "1 serving",
              gramWeight: 50,
              quantity: 1,
            },
          ],
          macros: { protein: 20, fat: 10, carbs: 50, calories: 400 },
          itemCount: 2,
        },
      ],
    };

    const normalized = normalizeFirstMeal(syntheticMultiItemPayload);

    expect(normalized.foodName).toBe("Synthetic multi-item meal");
    expect(normalized.foodDescription).toBe("Synthetic multi-item meal");
    expect(normalized.numberOfUnits).toBeNull();
    expect(normalized.servingUnit).toBeNull();
    expect(normalized.servingWeightGrams).toBeNull();
    expect(normalized.nutrients).toContainEqual({ nutrientId: "calories", amount: 400 });
    expect(normalized.nutrients).toHaveLength(4);
  });

  it("preserves explicit zero for every verified whole-meal macro", () => {
    const normalized = normalizeFirstMeal({
      meals: [
        {
          ...BASE_MEAL,
          macros: { protein: 0, fat: 0, carbs: 0, calories: 0 },
        },
      ],
    });

    expect(normalized.nutrients).toEqual([
      { nutrientId: "calories", amount: 0 },
      { nutrientId: "protein", amount: 0 },
      { nutrientId: "carbohydrate", amount: 0 },
      { nutrientId: "fat", amount: 0 },
    ]);
  });

  it("distinguishes absent and explicit-zero unverified fiber only in raw provenance", () => {
    const withoutFiber = normalizeFirstMeal();
    const withFiber = normalizeFirstMeal({
      ...observedMealFixture,
      meals: [
        {
          ...BASE_MEAL,
          macros: { ...BASE_MEAL.macros, fiber: 0 },
        },
      ],
    });

    expect(withoutFiber.nutrients).toHaveLength(4);
    expect(withoutFiber.raw).not.toHaveProperty("macros.fiber");
    expect(withFiber.nutrients).toHaveLength(4);
    expect(withFiber.nutrients).not.toContainEqual({ nutrientId: "fiber", amount: 0 });
    expect(withFiber.raw).toHaveProperty("macros.fiber", 0);
  });

  it("retains unsupported sodium and kilojoules without importing or converting them", () => {
    const normalized = normalizeFirstMeal({
      ...observedMealFixture,
      meals: [
        {
          ...BASE_MEAL,
          macros: { ...BASE_MEAL.macros, sodium: 123, kilojoules: 456 },
        },
      ],
    });

    expect(normalized.nutrients).toEqual([
      { nutrientId: "calories", amount: 321 },
      { nutrientId: "protein", amount: 12 },
      { nutrientId: "carbohydrate", amount: 34 },
      { nutrientId: "fat", amount: 15 },
    ]);
    expect(normalized.raw).toHaveProperty("macros.sodium", 123);
    expect(normalized.raw).toHaveProperty("macros.kilojoules", 456);
  });

  it("treats daily targets and instructions as inert top-level metadata", () => {
    const payload = parsePayload();
    const normalized = normalizeZivaMeal(payload.meals[0] ?? BASE_MEAL, {
      sourceAccountKey: "opaque-account-key-a",
    });

    expect(payload).toHaveProperty("dailyTargets");
    expect(payload).toHaveProperty("instructions");
    expect(normalized.nutrients).toHaveLength(4);
    expect(normalized.raw).not.toHaveProperty("dailyTargets");
    expect(normalized.raw).not.toHaveProperty("instructions");
  });

  it("ignores synthetic unsupported nutrient bases while retaining them in raw provenance", () => {
    const normalized = normalizeFirstMeal({
      meals: [
        {
          ...BASE_MEAL,
          perServingMacros: { calories: 999, protein: 99, carbs: 99, fat: 99 },
          per100GramMacros: { calories: 888, protein: 88, carbs: 88, fat: 88 },
        },
      ],
    });

    expect(normalized.nutrients).toEqual([
      { nutrientId: "calories", amount: 321 },
      { nutrientId: "protein", amount: 12 },
      { nutrientId: "carbohydrate", amount: 34 },
      { nutrientId: "fat", amount: 15 },
    ]);
    expect(normalized.raw).toHaveProperty("perServingMacros.calories", 999);
    expect(normalized.raw).toHaveProperty("per100GramMacros.calories", 888);
  });

  it.each(["perServingMacros", "per100GramMacros"] as const)(
    "rejects %s as a substitute for the complete observed whole-meal macros",
    (unsupportedBasis) => {
      const mealWithoutMacros = { ...BASE_MEAL };
      Reflect.deleteProperty(mealWithoutMacros, "macros");

      expect(() =>
        parsePayload({
          meals: [
            {
              ...mealWithoutMacros,
              [unsupportedBasis]: { calories: 321, protein: 12, carbs: 34, fat: 15 },
            },
          ],
        }),
      ).toThrow();
    },
  );

  it("derives a stable meal digest within the supplied opaque account namespace", () => {
    const first = normalizeFirstMeal();
    const repeated = normalizeFirstMeal();
    const secondUser = normalizeFirstMeal(observedMealFixture, {
      sourceAccountKey: "opaque-account-key-b",
    });
    const secondAccount = normalizeFirstMeal(observedMealFixture, {
      sourceAccountKey: "opaque-account-key-c",
    });

    expect(first.sourceAccountKey).toBe("opaque-account-key-a");
    expect(first.externalId).toBe(
      "meal:b1a6117a00cbfa7a82c84bf678847a73eb58c4944bf0d5e5c9d934de13c33651",
    );
    expect(repeated).toMatchObject({
      sourceAccountKey: first.sourceAccountKey,
      externalId: first.externalId,
    });
    expect(secondUser).toMatchObject({
      sourceAccountKey: "opaque-account-key-b",
      externalId: "meal:390eba6f910576161e2135f81278d2b223a5bf1b529dc8014754fd7cf143c1c1",
    });
    expect(secondAccount).toMatchObject({
      sourceAccountKey: "opaque-account-key-c",
      externalId: "meal:9784eed929b9c3cebcc8e4747c85eecbcf6a177ecb66fe5c8ba6bf9692980042",
    });
    expect(secondUser.externalId).not.toBe(first.externalId);
    expect(secondAccount.externalId).not.toBe(first.externalId);
    expect(first.externalId).not.toContain("meal_sanitized_001");
  });
});
