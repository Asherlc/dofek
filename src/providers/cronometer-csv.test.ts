import { describe, expect, it } from "vitest";
import {
  CRONOMETER_PROVIDER_ID,
  CronometerCsvProvider,
  mapCronometerMeal,
  parseCronometerCsv,
  parseOptionalNumber,
} from "./cronometer-csv.ts";

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
    expect(mapCronometerMeal("dessert")).toBe("other");
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

  it("converts empty unit and category to null", () => {
    const csv = [csvHeader, makeRow({ Unit: "", Category: "" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.unit).toBeNull();
    expect(entries[0]?.category).toBeNull();
  });

  it("handles escaped double quotes in CSV fields", () => {
    // Test the parseCsvLine function's escaped-quote handling
    const csv = [
      csvHeader,
      '2024-03-15,Breakfast,"Food ""Deluxe""",100,g,Other,200,10,25,8,3,2,1.5,3,0.1,15,100,300,5,50,10,2,1.5,20,0.2,0.3,2,0.5,0.3,5,40,1.2,120,2,30,1.5,10,0.2,0.5,5,15,0.5,1.2,70,0,0',
    ].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.foodName).toBe('Food "Deluxe"');
  });

  it("handles amount as null when empty", () => {
    const csv = [csvHeader, makeRow({ Amount: "" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.amount).toBeNull();
  });

  it("parses row with exactly 6 fields (MIN_FIELDS boundary)", () => {
    const csv = [csvHeader, "2024-03-15,Lunch,Rice,150,g,Grains"].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toBe("2024-03-15");
    expect(entries[0]?.meal).toBe("lunch");
    expect(entries[0]?.foodName).toBe("Rice");
    expect(entries[0]?.calories).toBeNull();
  });

  it("skips row with only 5 fields (below MIN_FIELDS)", () => {
    const csv = [csvHeader, "2024-03-15,Lunch,Rice,150,g"].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(0);
  });

  it("empty unit is strictly null not empty string", () => {
    const csv = [csvHeader, makeRow({ Unit: "" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.unit).toStrictEqual(null);
    expect(entries[0]?.unit).not.toBe("");
  });

  it("empty category is strictly null not empty string", () => {
    const csv = [csvHeader, makeRow({ Category: "" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.category).toStrictEqual(null);
  });

  it("gramsToMg rounds to 2 decimal places", () => {
    // 0.12345g -> 123.45mg
    const csv = [csvHeader, makeRow({ "Omega-3": "0.12345" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.omega3Mg).toBe(123.45);
  });

  it("gramsToMg converts 0g to 0mg not null", () => {
    const csv = [csvHeader, makeRow({ "Omega-3": "0", "Omega-6": "0" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.omega3Mg).toBe(0);
    expect(entries[0]?.omega6Mg).toBe(0);
  });

  it("gramsToMg with small value", () => {
    // 0.001g -> 1mg
    const csv = [csvHeader, makeRow({ "Omega-3": "0.001" })].join("\n");
    const entries = parseCronometerCsv(csv);
    expect(entries[0]?.omega3Mg).toBe(1);
  });
});

describe("parseCronometerCsv — abbreviated export header", () => {
  const header =
    "Day,Meal,Food Name,Amount,Unit,Category,Energy (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g),Sat Fat (g),Poly Fat (g),Mono Fat (g),Trans Fat (g),Cholesterol (mg),Sodium (mg),Potassium (mg),Sugar (g),Vit A (mcg),Vit C (mg),Vit D (mcg),Vit E (mg),Vit K (mcg),Thiamin (mg),Riboflavin (mg),Niacin (mg),Pant Acid (mg),B6 (mg),Biotin (mcg),Folate (mcg),B12 (mcg),Calcium (mg),Iron (mg),Magnesium (mg),Zinc (mg),Selenium (mcg),Copper (mg),Manganese (mg),Chromium (mcg),Iodine (mcg),Omega 3 (g),Omega 6 (g),Water (g),Caffeine (mg)";

  it("parses a single data row with all fields", () => {
    const row =
      "2026-03-01,Breakfast,Oatmeal,1,cup,Grains,300,10,50,5,8,1,1.5,2,0,0,5,200,3,100,10,5,2,10,0.5,0.3,3,1,0.5,5,50,1,200,3,100,5,20,0.5,2,5,50,0.5,2,250,50";
    const csv = `${header}\n${row}`;

    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry?.date).toBe("2026-03-01");
    expect(entry?.meal).toBe("breakfast");
    expect(entry?.foodName).toBe("Oatmeal");
    expect(entry?.amount).toBe(1);
    expect(entry?.unit).toBe("cup");
    expect(entry?.category).toBe("Grains");
    expect(entry?.calories).toBe(300);
    expect(entry?.proteinG).toBe(10);
    expect(entry?.carbsG).toBe(50);
    expect(entry?.fatG).toBe(5);
    expect(entry?.fiberG).toBe(8);
    expect(entry?.omega3Mg).toBe(500);
    expect(entry?.omega6Mg).toBe(2000);
    expect(entry?.waterG).toBe(250);
    expect(entry?.caffeineMg).toBe(50);
  });

  it("handles BOM-prefixed CSV", () => {
    const csv = `\uFEFF${header}\n2026-03-01,Lunch,Rice,1,cup,Grains,200,4,45,0.5,1,0,0,0,0,0,1,50,0.5,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toBe("2026-03-01");
  });

  it("handles quoted fields with commas", () => {
    const csv = `${header}\n2026-03-01,Dinner,"Chicken, grilled",200,g,Protein,250,30,0,12,0,3,2,5,0,80,70,300,0,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.foodName).toBe("Chicken, grilled");
  });

  it("handles multiple data rows", () => {
    const rows = [
      "2026-03-01,Breakfast,Eggs,2,large,Protein,140,12,1,10,0,3,1.5,4,0,370,140,130,1,,,,,,,,,,,,,,,,,,,,,,,,,",
      "2026-03-01,Lunch,Salad,1,bowl,Vegetables,100,3,10,5,3,0.5,1,2,0,0,50,400,3,,,,,,,,,,,,,,,,,,,,,,,,,",
    ];
    const csv = `${header}\n${rows.join("\n")}`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.foodName).toBe("Eggs");
    expect(entries[1]?.foodName).toBe("Salad");
  });

  it("handles missing optional fields gracefully", () => {
    const csv = `${header}\n2026-03-01,Snack,Apple,1,medium,Fruit`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.calories).toBeNull();
    expect(entries[0]?.omega3Mg).toBeNull();
  });

  it("handles empty unit and category", () => {
    const csv = `${header}\n2026-03-01,Lunch,Water,1,,,0,0,0,0,0,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.unit).toBeNull();
    expect(entries[0]?.category).toBeNull();
  });
});

describe("CronometerCsvProvider", () => {
  it("has correct id and name", () => {
    const provider = new CronometerCsvProvider();
    expect(provider.id).toBe(CRONOMETER_PROVIDER_ID);
    expect(provider.name).toBe("Cronometer");
  });

  it("validate always returns null", () => {
    const provider = new CronometerCsvProvider();
    expect(provider.validate()).toBeNull();
  });

  it("is an import-only provider", () => {
    const provider = new CronometerCsvProvider();
    expect(provider.importOnly).toBe(true);
  });
});

describe("parseOptionalNumber — mutation-killing edge cases", () => {
  it("returns null for tab-only input", () => {
    expect(parseOptionalNumber("\t")).toBeNull();
  });

  it("returns null for NaN string", () => {
    expect(parseOptionalNumber("NaN")).toBeNull();
  });

  it("parses string with leading whitespace", () => {
    expect(parseOptionalNumber("  42")).toBe(42);
  });

  it("distinguishes empty string from zero", () => {
    expect(parseOptionalNumber("")).toBeNull();
    expect(parseOptionalNumber("0")).toBe(0);
  });

  it("returns null for mixed whitespace", () => {
    expect(parseOptionalNumber("  \t  ")).toBeNull();
  });

  it("parses negative numbers", () => {
    expect(parseOptionalNumber("-10")).toBe(-10);
    expect(parseOptionalNumber("-1.5")).toBe(-1.5);
  });
});
