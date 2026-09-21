// cspell:ignore Ziva
import { describe, expect, it } from "vitest";
import { summarizeZivaDiagnostic } from "./diagnostic.ts";
import { parseZivaMealPayload } from "./schemas.ts";

const SENSITIVE = {
  bearer: "sensitive-bearer-token",
  description: "sensitive-meal-description",
  food: "sensitive-food-name",
  itemId: "sensitive-item-id",
  jwtSubject: "sensitive-jwt-subject",
  mealId: "sensitive-meal-id",
  portion: "sensitive-portion",
  rawText: "sensitive-raw-tool-text",
};

function sensitivePayload() {
  return parseZivaMealPayload(
    {
      meals: [
        {
          mealId: SENSITIVE.mealId,
          description: SENSITIVE.description,
          mealDate: "2026-09-20",
          mealType: "lunch",
          mealTime: null,
          createdAt: "2026-09-20T12:34:56Z",
          itemCount: 1,
          items: [
            {
              itemId: SENSITIVE.itemId,
              food: SENSITIVE.food,
              portion: SENSITIVE.portion,
              gramWeight: null,
              quantity: 1,
              bearer: SENSITIVE.bearer,
            },
          ],
          macros: {
            calories: 987,
            protein: 65,
            carbs: 43,
            fat: 21,
            jwtSubject: SENSITIVE.jwtSubject,
          },
          rawText: SENSITIVE.rawText,
        },
      ],
      bearer: SENSITIVE.bearer,
      jwtClaims: { sub: SENSITIVE.jwtSubject },
      rawText: SENSITIVE.rawText,
    },
    { expectedDate: "2026-09-20" },
  );
}

describe("summarizeZivaDiagnostic", () => {
  it("returns only allowlisted field-presence metadata", () => {
    const summary = summarizeZivaDiagnostic(sensitivePayload(), {
      mealToolPresent: true,
    });

    expect(summary).toEqual({
      tools: { get_meals_for_date: true },
      mealCount: 1,
      mealFields: {
        description: true,
        mealDate: true,
        mealType: true,
        mealTime: true,
        createdAt: true,
        itemCount: true,
        items: true,
        macros: true,
      },
      itemFields: {
        food: true,
        portion: true,
        quantity: true,
      },
      macroKeys: {
        calories: true,
        protein: true,
        carbs: true,
        fat: true,
      },
      presence: {
        mealId: true,
        itemId: true,
        gramWeight: true,
      },
    });

    const serialized = JSON.stringify(summary);
    for (const privateValue of Object.values(SENSITIVE)) {
      expect(serialized).not.toContain(privateValue);
    }
    for (const nutrientAmount of [987, 65, 43, 21]) {
      expect(serialized).not.toContain(String(nutrientAmount));
    }
    expect(Object.keys(summary)).toEqual([
      "tools",
      "mealCount",
      "mealFields",
      "itemFields",
      "macroKeys",
      "presence",
    ]);
  });

  it("treats key existence as evidence even when gramWeight is null", () => {
    const summary = summarizeZivaDiagnostic(sensitivePayload(), {
      mealToolPresent: true,
    });

    expect(summary.presence.gramWeight).toBe(true);
  });

  it("reports no field evidence for an empty result", () => {
    expect(
      summarizeZivaDiagnostic(parseZivaMealPayload({ meals: [] }, { expectedDate: "2026-09-20" }), {
        mealToolPresent: true,
      }),
    ).toEqual({
      tools: { get_meals_for_date: true },
      mealCount: 0,
      mealFields: {
        description: false,
        mealDate: false,
        mealType: false,
        mealTime: false,
        createdAt: false,
        itemCount: false,
        items: false,
        macros: false,
      },
      itemFields: {
        food: false,
        portion: false,
        quantity: false,
      },
      macroKeys: {
        calories: false,
        protein: false,
        carbs: false,
        fat: false,
      },
      presence: {
        mealId: false,
        itemId: false,
        gramWeight: false,
      },
    });
  });
});
