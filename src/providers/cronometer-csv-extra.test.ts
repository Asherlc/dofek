import { describe, expect, it } from "vitest";
import {
  CRONOMETER_PROVIDER_ID,
  CronometerCsvProvider,
  mapCronometerMeal,
  parseCronometerCsv,
  parseOptionalNumber,
} from "./cronometer-csv.ts";

// ============================================================
// Tests targeting uncovered CSV parsing paths in cronometer-csv.ts
// ============================================================

describe("parseOptionalNumber", () => {
  it("returns null for empty string", () => {
    expect(parseOptionalNumber("")).toBeNull();
  });

  it("returns null for whitespace", () => {
    expect(parseOptionalNumber("   ")).toBeNull();
  });

  it("returns null for non-numeric strings", () => {
    expect(parseOptionalNumber("abc")).toBeNull();
    expect(parseOptionalNumber("N/A")).toBeNull();
  });

  it("parses valid integers", () => {
    expect(parseOptionalNumber("42")).toBe(42);
    expect(parseOptionalNumber("0")).toBe(0);
  });

  it("parses valid floats", () => {
    expect(parseOptionalNumber("3.14")).toBe(3.14);
    expect(parseOptionalNumber("0.5")).toBe(0.5);
  });

  it("parses negative numbers", () => {
    expect(parseOptionalNumber("-10")).toBe(-10);
    expect(parseOptionalNumber("-1.5")).toBe(-1.5);
  });
});

describe("mapCronometerMeal", () => {
  it("maps known meals case-insensitively", () => {
    expect(mapCronometerMeal("Breakfast")).toBe("breakfast");
    expect(mapCronometerMeal("LUNCH")).toBe("lunch");
    expect(mapCronometerMeal("Dinner")).toBe("dinner");
    expect(mapCronometerMeal("Snack")).toBe("snack");
    expect(mapCronometerMeal("Snacks")).toBe("snack");
  });

  it("returns other for unknown meals", () => {
    expect(mapCronometerMeal("Brunch")).toBe("other");
    expect(mapCronometerMeal("dessert")).toBe("other");
  });
});

describe("parseCronometerCsv", () => {
  const header =
    "Day,Meal,Food Name,Amount,Unit,Category,Energy (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g),Sat Fat (g),Poly Fat (g),Mono Fat (g),Trans Fat (g),Cholesterol (mg),Sodium (mg),Potassium (mg),Sugar (g),Vit A (mcg),Vit C (mg),Vit D (mcg),Vit E (mg),Vit K (mcg),Thiamin (mg),Riboflavin (mg),Niacin (mg),Pant Acid (mg),B6 (mg),Biotin (mcg),Folate (mcg),B12 (mcg),Calcium (mg),Iron (mg),Magnesium (mg),Zinc (mg),Selenium (mcg),Copper (mg),Manganese (mg),Chromium (mcg),Iodine (mcg),Omega 3 (g),Omega 6 (g),Water (g),Caffeine (mg)";

  it("returns empty array for empty input", () => {
    expect(parseCronometerCsv("")).toEqual([]);
  });

  it("returns empty array for header-only input", () => {
    expect(parseCronometerCsv(header)).toEqual([]);
  });

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
    expect(entry?.saturatedFatG).toBe(1);
    expect(entry?.polyunsaturatedFatG).toBe(1.5);
    expect(entry?.monounsaturatedFatG).toBe(2);
    expect(entry?.transFatG).toBe(0);
    expect(entry?.cholesterolMg).toBe(0);
    expect(entry?.sodiumMg).toBe(5);
    expect(entry?.potassiumMg).toBe(200);
    expect(entry?.sugarG).toBe(3);
    // Vitamins
    expect(entry?.vitaminAMcg).toBe(100);
    expect(entry?.vitaminCMg).toBe(10);
    expect(entry?.vitaminDMcg).toBe(5);
    expect(entry?.vitaminEMg).toBe(2);
    expect(entry?.vitaminKMcg).toBe(10);
    expect(entry?.vitaminB1Mg).toBe(0.5);
    expect(entry?.vitaminB2Mg).toBe(0.3);
    expect(entry?.vitaminB3Mg).toBe(3);
    expect(entry?.vitaminB5Mg).toBe(1);
    expect(entry?.vitaminB6Mg).toBe(0.5);
    expect(entry?.vitaminB7Mcg).toBe(5);
    expect(entry?.vitaminB9Mcg).toBe(50);
    expect(entry?.vitaminB12Mcg).toBe(1);
    // Minerals
    expect(entry?.calciumMg).toBe(200);
    expect(entry?.ironMg).toBe(3);
    expect(entry?.magnesiumMg).toBe(100);
    expect(entry?.zincMg).toBe(5);
    expect(entry?.seleniumMcg).toBe(20);
    expect(entry?.copperMg).toBe(0.5);
    expect(entry?.manganeseMg).toBe(2);
    expect(entry?.chromiumMcg).toBe(5);
    expect(entry?.iodineMcg).toBe(50);
    // Omega fatty acids: 0.5g = 500mg, 2g = 2000mg
    expect(entry?.omega3Mg).toBe(500);
    expect(entry?.omega6Mg).toBe(2000);
    // Extra
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

  it("skips lines with fewer than MIN_FIELDS", () => {
    const csv = `${header}\nshort,line`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(0);
  });

  it("handles missing optional fields gracefully", () => {
    const csv = `${header}\n2026-03-01,Snack,Apple,1,medium,Fruit`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.calories).toBeNull();
    expect(entries[0]?.omega3Mg).toBeNull();
  });

  it("handles Windows-style line endings", () => {
    const csv = `${header}\r\n2026-03-01,Breakfast,Toast,2,slices,Grains,160,4,30,2,2,0.5,0.5,0.5,0,0,300,50,2,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const entries = parseCronometerCsv(csv);
    expect(entries).toHaveLength(1);
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

  it("sync returns zero records", async () => {
    const provider = new CronometerCsvProvider();
    // @ts-expect-error mock DB
    const result = await provider.sync({}, new Date());
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
