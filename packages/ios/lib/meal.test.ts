import { describe, expect, it } from "vitest";
import { autoMealType, formatDateYmd } from "./meal";

describe("autoMealType", () => {
  it("returns breakfast before 10am", () => {
    expect(autoMealType(0)).toBe("breakfast");
    expect(autoMealType(6)).toBe("breakfast");
    expect(autoMealType(9)).toBe("breakfast");
  });

  it("returns lunch from 10am to 1pm", () => {
    expect(autoMealType(10)).toBe("lunch");
    expect(autoMealType(13)).toBe("lunch");
  });

  it("returns snack from 2pm to 4pm", () => {
    expect(autoMealType(14)).toBe("snack");
    expect(autoMealType(16)).toBe("snack");
  });

  it("returns dinner from 5pm onward", () => {
    expect(autoMealType(17)).toBe("dinner");
    expect(autoMealType(21)).toBe("dinner");
    expect(autoMealType(23)).toBe("dinner");
  });
});

describe("formatDateYmd", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(formatDateYmd(new Date(2026, 2, 17))).toBe("2026-03-17");
  });

  it("zero-pads single-digit months and days", () => {
    expect(formatDateYmd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
