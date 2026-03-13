import { describe, expect, it } from "vitest";
import { mapCronometerMeal, parseCronometerCsv, parseOptionalNumber } from "../cronometer-csv.ts";

describe("parseOptionalNumber", () => {
  it("parses a valid integer", () => {
    expect(parseOptionalNumber("130")).toBe(130);
  });

  it("parses a valid float", () => {
    expect(parseOptionalNumber("12.5")).toBe(12.5);
  });

  it("returns null for empty string", () => {
    expect(parseOptionalNumber("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseOptionalNumber("  ")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(parseOptionalNumber("abc")).toBeNull();
  });

  it("parses zero", () => {
    expect(parseOptionalNumber("0")).toBe(0);
  });

  it("parses zero with decimal", () => {
    expect(parseOptionalNumber("0.0")).toBe(0);
  });
});

describe("mapCronometerMeal", () => {
  it("maps Breakfast", () => {
    expect(mapCronometerMeal("Breakfast")).toBe("breakfast");
  });

  it("maps Lunch", () => {
    expect(mapCronometerMeal("Lunch")).toBe("lunch");
  });

  it("maps Dinner", () => {
    expect(mapCronometerMeal("Dinner")).toBe("dinner");
  });

  it("maps Snack", () => {
    expect(mapCronometerMeal("Snack")).toBe("snack");
  });

  it("maps Snacks (plural)", () => {
    expect(mapCronometerMeal("Snacks")).toBe("snack");
  });

  it("is case-insensitive", () => {
    expect(mapCronometerMeal("breakfast")).toBe("breakfast");
    expect(mapCronometerMeal("DINNER")).toBe("dinner");
  });

  it("returns other for unknown meal", () => {
    expect(mapCronometerMeal("Brunch")).toBe("other");
    expect(mapCronometerMeal("")).toBe("other");
  });
});

describe("parseCronometerCsv", () => {
  const csvHeader = [
    "Day",
    "Meal",
    "Food Name",
    "Amount",
    "Unit",
    "Category",
    "Energy (kcal)",
    "Protein (g)",
    "Carbs (g)",
    "Fat (g)",
    "Fiber (g)",
    "Saturated Fat (g)",
    "Polyunsaturated Fat (g)",
    "Monounsaturated Fat (g)",
    "Trans Fat (g)",
    "Cholesterol (mg)",
    "Sodium (mg)",
    "Potassium (mg)",
    "Sugar (g)",
    "Vitamin A (\u00b5g)",
    "Vitamin C (mg)",
    "Vitamin D (\u00b5g)",
    "Vitamin E (mg)",
    "Vitamin K (\u00b5g)",
    "Thiamin (mg)",
    "Riboflavin (mg)",
    "Niacin (mg)",
    "Pantothenic Acid (mg)",
    "Vitamin B6 (mg)",
    "Biotin (\u00b5g)",
    "Folate (\u00b5g)",
    "Vitamin B12 (\u00b5g)",
    "Calcium (mg)",
    "Iron (mg)",
    "Magnesium (mg)",
    "Zinc (mg)",
    "Selenium (\u00b5g)",
    "Copper (mg)",
    "Manganese (mg)",
    "Chromium (\u00b5g)",
    "Iodine (\u00b5g)",
    "Omega-3 (g)",
    "Omega-6 (g)",
    "Water (g)",
    "Caffeine (mg)",
    "Alcohol (g)",
  ].join(",");

  // Helper: build a data row with all 46 columns
  // Columns: Day, Meal, FoodName, Amount, Unit, Category, then 40 nutrient columns
  function makeRow(overrides: Record<string, string> = {}): string {
    const defaults: Record<string, string> = {
      Day: "2024-03-15",
      Meal: "Breakfast",
      "Food Name": "Test Food",
      Amount: "100",
      Unit: "g",
      Category: "Other",
      // Nutrients (indices 6-45)
      "Energy (kcal)": "200",
      "Protein (g)": "10.0",
      "Carbs (g)": "25.0",
      "Fat (g)": "8.0",
      "Fiber (g)": "3.0",
      "Saturated Fat (g)": "2.0",
      "Polyunsaturated Fat (g)": "1.5",
      "Monounsaturated Fat (g)": "3.0",
      "Trans Fat (g)": "0.1",
      "Cholesterol (mg)": "15",
      "Sodium (mg)": "100",
      "Potassium (mg)": "300",
      "Sugar (g)": "5.0",
      "Vitamin A": "50",
      "Vitamin C": "10.0",
      "Vitamin D": "2.0",
      "Vitamin E": "1.5",
      "Vitamin K": "20.0",
      Thiamin: "0.2",
      Riboflavin: "0.3",
      Niacin: "2.0",
      "Pantothenic Acid": "0.5",
      "Vitamin B6": "0.3",
      Biotin: "5.0",
      Folate: "40.0",
      "Vitamin B12": "1.2",
      Calcium: "120",
      Iron: "2.0",
      Magnesium: "30",
      Zinc: "1.5",
      Selenium: "10.0",
      Copper: "0.2",
      Manganese: "0.5",
      Chromium: "5.0",
      Iodine: "15.0",
      "Omega-3": "0.5",
      "Omega-6": "1.2",
      Water: "70",
      Caffeine: "0.0",
      Alcohol: "0.0",
    };
    const merged = { ...defaults, ...overrides };
    // Build array in column order
    const fields = [
      merged.Day,
      merged.Meal,
      // Quote food name if it contains commas
      merged["Food Name"]?.includes(",") ? `"${merged["Food Name"]}"` : merged["Food Name"],
      merged.Amount,
      merged.Unit,
      merged.Category,
      merged["Energy (kcal)"],
      merged["Protein (g)"],
      merged["Carbs (g)"],
      merged["Fat (g)"],
      merged["Fiber (g)"],
      merged["Saturated Fat (g)"],
      merged["Polyunsaturated Fat (g)"],
      merged["Monounsaturated Fat (g)"],
      merged["Trans Fat (g)"],
      merged["Cholesterol (mg)"],
      merged["Sodium (mg)"],
      merged["Potassium (mg)"],
      merged["Sugar (g)"],
      merged["Vitamin A"],
      merged["Vitamin C"],
      merged["Vitamin D"],
      merged["Vitamin E"],
      merged["Vitamin K"],
      merged.Thiamin,
      merged.Riboflavin,
      merged.Niacin,
      merged["Pantothenic Acid"],
      merged["Vitamin B6"],
      merged.Biotin,
      merged.Folate,
      merged["Vitamin B12"],
      merged.Calcium,
      merged.Iron,
      merged.Magnesium,
      merged.Zinc,
      merged.Selenium,
      merged.Copper,
      merged.Manganese,
      merged.Chromium,
      merged.Iodine,
      merged["Omega-3"],
      merged["Omega-6"],
      merged.Water,
      merged.Caffeine,
      merged.Alcohol,
    ];
    return fields.join(",");
  }

  it("parses a single row with all nutrients", () => {
    const csv = [csvHeader, makeRow()].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.date).toBe("2024-03-15");
    expect(entry.meal).toBe("breakfast");
    expect(entry.foodName).toBe("Test Food");
    expect(entry.amount).toBe(100);
    expect(entry.unit).toBe("g");
    expect(entry.category).toBe("Other");

    // Macros
    expect(entry.calories).toBe(200);
    expect(entry.proteinG).toBe(10.0);
    expect(entry.carbsG).toBe(25.0);
    expect(entry.fatG).toBe(8.0);
    expect(entry.fiberG).toBe(3.0);

    // Fat breakdown
    expect(entry.saturatedFatG).toBe(2.0);
    expect(entry.polyunsaturatedFatG).toBe(1.5);
    expect(entry.monounsaturatedFatG).toBe(3.0);
    expect(entry.transFatG).toBe(0.1);

    // Minerals / electrolytes
    expect(entry.cholesterolMg).toBe(15);
    expect(entry.sodiumMg).toBe(100);
    expect(entry.potassiumMg).toBe(300);
    expect(entry.sugarG).toBe(5.0);

    // Vitamins
    expect(entry.vitaminAMcg).toBe(50);
    expect(entry.vitaminCMg).toBe(10.0);
    expect(entry.vitaminDMcg).toBe(2.0);
    expect(entry.vitaminEMg).toBe(1.5);
    expect(entry.vitaminKMcg).toBe(20.0);
    expect(entry.vitaminB1Mg).toBe(0.2); // Thiamin
    expect(entry.vitaminB2Mg).toBe(0.3); // Riboflavin
    expect(entry.vitaminB3Mg).toBe(2.0); // Niacin
    expect(entry.vitaminB5Mg).toBe(0.5); // Pantothenic Acid
    expect(entry.vitaminB6Mg).toBe(0.3);
    expect(entry.vitaminB7Mcg).toBe(5.0); // Biotin
    expect(entry.vitaminB9Mcg).toBe(40.0); // Folate
    expect(entry.vitaminB12Mcg).toBe(1.2);

    // Minerals
    expect(entry.calciumMg).toBe(120);
    expect(entry.ironMg).toBe(2.0);
    expect(entry.magnesiumMg).toBe(30);
    expect(entry.zincMg).toBe(1.5);
    expect(entry.seleniumMcg).toBe(10.0);
    expect(entry.copperMg).toBe(0.2);
    expect(entry.manganeseMg).toBe(0.5);
    expect(entry.chromiumMcg).toBe(5.0);
    expect(entry.iodineMcg).toBe(15.0);

    // Fatty acids (converted g -> mg)
    expect(entry.omega3Mg).toBe(500); // 0.5g * 1000
    expect(entry.omega6Mg).toBe(1200); // 1.2g * 1000

    // Extra
    expect(entry.waterG).toBe(70);
    expect(entry.caffeineMg).toBe(0.0);
  });

  it("parses multiple rows", () => {
    const csv = [
      csvHeader,
      makeRow({ "Food Name": "Apple", Meal: "Breakfast" }),
      makeRow({ "Food Name": "Chicken", Meal: "Lunch" }),
      makeRow({ "Food Name": "Salmon", Meal: "Dinner" }),
    ].join("\n");

    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.foodName).toBe("Apple");
    expect(entries[0]?.meal).toBe("breakfast");
    expect(entries[1]?.foodName).toBe("Chicken");
    expect(entries[1]?.meal).toBe("lunch");
    expect(entries[2]?.foodName).toBe("Salmon");
    expect(entries[2]?.meal).toBe("dinner");
  });

  it("handles BOM character", () => {
    const csv = [`\uFEFF${csvHeader}`, makeRow()].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toBe("2024-03-15");
  });

  it("handles Windows line endings", () => {
    const csv = [csvHeader, makeRow()].join("\r\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
  });

  it("converts omega-3 and omega-6 from grams to milligrams", () => {
    const csv = [csvHeader, makeRow({ "Omega-3": "2.5", "Omega-6": "0.3" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.omega3Mg).toBe(2500);
    expect(entries[0]?.omega6Mg).toBe(300);
  });

  it("returns empty array for empty CSV", () => {
    expect(parseCronometerCsv("")).toEqual([]);
    expect(parseCronometerCsv(csvHeader)).toEqual([]);
  });

  it("handles empty nutrient values as null", () => {
    const csv = [
      csvHeader,
      makeRow({
        "Protein (g)": "",
        "Carbs (g)": "",
        "Fat (g)": "",
        "Fiber (g)": "",
      }),
    ].join("\n");

    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.calories).toBe(200);
    expect(entries[0]?.proteinG).toBeNull();
    expect(entries[0]?.carbsG).toBeNull();
    expect(entries[0]?.fatG).toBeNull();
    expect(entries[0]?.fiberG).toBeNull();
  });

  it("handles quoted food names with commas", () => {
    const csv = [csvHeader, makeRow({ "Food Name": "Pasta, Whole Wheat, Cooked" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.foodName).toBe("Pasta, Whole Wheat, Cooked");
  });

  it("skips lines with too few fields", () => {
    const csv = [csvHeader, "2024-03-15,Breakfast,Apple"].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(0);
  });

  it("handles snack meal type", () => {
    const csv = [csvHeader, makeRow({ Meal: "Snack" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.meal).toBe("snack");
  });

  it("handles null omega values", () => {
    const csv = [csvHeader, makeRow({ "Omega-3": "", "Omega-6": "" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.omega3Mg).toBeNull();
    expect(entries[0]?.omega6Mg).toBeNull();
  });
});
