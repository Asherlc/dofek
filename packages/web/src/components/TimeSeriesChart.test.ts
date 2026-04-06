import { describe, expect, it } from "vitest";
import { isSeriesEmpty } from "./TimeSeriesChart.tsx";

describe("isSeriesEmpty", () => {
  it("returns true when all values are null", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
            ["2026-04-03", null],
          ],
        },
      ]),
    ).toBe(true);
  });

  it("returns false when at least one value is non-null", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", 5000],
            ["2026-04-03", null],
          ],
        },
      ]),
    ).toBe(false);
  });

  it("returns true when data array is empty", () => {
    expect(isSeriesEmpty([{ data: [] }])).toBe(true);
  });

  it("returns true when series array is empty", () => {
    expect(isSeriesEmpty([])).toBe(true);
  });

  it("returns false when any series has non-null data in a multi-series chart", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
          ],
        },
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", 34.5],
          ],
        },
      ]),
    ).toBe(false);
  });

  it("returns true when all series have all-null data", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
          ],
        },
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
          ],
        },
      ]),
    ).toBe(true);
  });
});
