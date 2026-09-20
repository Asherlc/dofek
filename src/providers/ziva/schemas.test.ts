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
  identity: { userId: string; accountSubject: string } = {
    userId: "user-alpha",
    accountSubject: "subject-alpha",
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
      userId: "user-alpha",
      accountSubject: "subject-alpha",
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

  it("derives exact stable tenant/account/meal digests without exposing raw identifiers", () => {
    const first = normalizeFirstMeal();
    const repeated = normalizeFirstMeal();
    const secondUser = normalizeFirstMeal(observedMealFixture, {
      userId: "user-beta",
      accountSubject: "subject-alpha",
    });
    const secondAccount = normalizeFirstMeal(observedMealFixture, {
      userId: "user-alpha",
      accountSubject: "subject-beta",
    });

    expect(first.sourceAccountKey).toBe(
      "8db0d5bc1cbf4da8a5240b19759f521aab47e48ee40d001848947f1ecb9f91a6",
    );
    expect(first.externalId).toBe(
      "meal:e928b8d793993fff487acfc1730df73f09e1a31499f8b174a2aeb88f40612b65",
    );
    expect(repeated).toMatchObject({
      sourceAccountKey: first.sourceAccountKey,
      externalId: first.externalId,
    });
    expect(secondUser).toMatchObject({
      sourceAccountKey: "c44b961f5c476b949fe8fc308dec1b578aa6f7f10b8762c2a5260a39056361e0",
      externalId: "meal:59b018bdc2287c04881600d2fe6d1b59f02a32690ab9be4475ca8c51dc96193b",
    });
    expect(secondAccount).toMatchObject({
      sourceAccountKey: "5867d106b11ca96dc4304dfc554fd57888dbe697bac46625855c611be6ec7ed1",
      externalId: "meal:b8c49fff437ede1001b2a1664522bda2caa0a83f870af004f762a320e3c1395c",
    });
    expect(secondUser.externalId).not.toBe(first.externalId);
    expect(secondAccount.externalId).not.toBe(first.externalId);
    expect(first.sourceAccountKey).not.toContain("subject-alpha");
    expect(first.externalId).not.toContain("meal_sanitized_001");
  });
});
