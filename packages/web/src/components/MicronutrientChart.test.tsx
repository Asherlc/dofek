/** @vitest-environment jsdom */

import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { MicronutrientChart } from "./MicronutrientChart.tsx";

interface ChartElementProps {
  option: {
    tooltip?: {
      formatter?: (params: Array<{ name: string; value: number; dataIndex: number }>) => unknown;
    };
    series?: Array<{
      markLine?: {
        label?: {
          formatter?: string;
        };
      };
    }>;
  };
}

function findChartElement(element: ReactElement): ReactElement<ChartElementProps> {
  if (isChartElement(element)) return element;
  const children = Array.isArray(element.props.children)
    ? element.props.children
    : [element.props.children];
  const chart = children.find(isChartElement);
  if (!chart) throw new Error("Expected MicronutrientChart to contain a chart element");
  return chart;
}

function isChartElement(value: unknown): value is ReactElement<ChartElementProps> {
  return (
    isValidElement(value) &&
    typeof value.props === "object" &&
    value.props !== null &&
    "option" in value.props
  );
}

function elementText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(elementText).join("");
  if (isValidElement(value)) return elementText(value.props.children);
  return "";
}

describe("MicronutrientChart", () => {
  it("escapes nutrient labels and units in HTML tooltips", () => {
    const element = MicronutrientChart({
      data: [
        {
          nutrientId: "vitamin_c",
          nutrient: '<img src=x onerror="alert(1)">',
          unit: '<svg onload="alert(1)">',
          intake: {
            totalDailyAverage: 5,
            foodDailyAverage: 5,
            providerDailyTotalAverage: 0,
            supplementDailyAverage: 0,
            daysTracked: 7,
          },
          sourceBreakdown: [
            {
              providerId: "unsafe",
              sourceLabel: '<img src=x onerror="alert(2)">',
              intakeType: "itemized_food",
              dailyAverageContribution: 5,
              daysTracked: 7,
            },
          ],
          adequacy: {
            status: "below_daily_value",
            percentDailyValue: 50,
            message: "Below the FDA Daily Value.",
            reference: {
              type: "daily_value",
              amount: 10,
              unit: '<svg onload="alert(1)">',
              population: "Adults and children age 4+",
              source: {
                agency: "FDA",
                title: "Daily Value",
                url: "https://www.fda.gov/",
                reviewedOn: "2026-07-27",
              },
            },
          },
          upperLimit: {
            status: "not_in_ruleset",
            limitation: "No upper-limit rule is included in this bounded ruleset.",
            message: "No upper-limit rule is included in this bounded ruleset.",
          },
          safetyStatus: "no_upper_limit_in_ruleset",
        },
      ],
      selectedWindowDays: 30,
    });
    const chartElement = findChartElement(element);
    const formatter = chartElement.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(formatter([{ name: "", value: 50, dataIndex: 0 }]));

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain("<svg ");
  });

  it("identifies the Daily Value as an adequacy reference rather than a safety rating", () => {
    const element = MicronutrientChart({
      data: [
        {
          nutrientId: "iron",
          nutrient: "Iron",
          unit: "mg",
          intake: {
            totalDailyAverage: 12,
            foodDailyAverage: 12,
            providerDailyTotalAverage: 0,
            supplementDailyAverage: 0,
            daysTracked: 7,
          },
          sourceBreakdown: [
            {
              providerId: "manual",
              sourceLabel: "Manual",
              intakeType: "itemized_food",
              dailyAverageContribution: 12,
              daysTracked: 7,
            },
          ],
          adequacy: {
            status: "below_daily_value",
            percentDailyValue: 67,
            message: "Below the FDA Daily Value.",
            reference: {
              type: "daily_value",
              amount: 18,
              unit: "mg",
              population: "Adults and children age 4+",
              source: {
                agency: "FDA",
                title: "Daily Value",
                url: "https://www.fda.gov/",
                reviewedOn: "2026-07-27",
              },
            },
          },
          upperLimit: {
            status: "not_in_ruleset",
            limitation: "No upper-limit rule is included in this bounded ruleset.",
            message: "No upper-limit rule is included in this bounded ruleset.",
          },
          safetyStatus: "no_upper_limit_in_ruleset",
        },
      ],
      selectedWindowDays: 30,
    });
    const chartElement = findChartElement(element);
    const formatter = chartElement.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(formatter([{ name: "Iron", value: 67, dataIndex: 0 }]));

    expect(html).toContain(
      "67% of U.S. Food and Drug Administration (FDA) Daily Value (adequacy reference, not a safety rating)",
    );
    expect(html).toContain("average over 7 recorded days");
    expect(html).toContain("Itemized food: 12 mg/day");
    expect(html).toContain("Provider daily totals: 0 mg/day");
    expect(html).toContain("Manual · Itemized food: 12 mg/day");
    expect(chartElement.props.option.series?.[0]?.markLine?.label?.formatter).toBe(
      "100% U.S. Food and Drug Administration (FDA) Daily Value",
    );
  });

  it("shows target and upper-limit context separately, including form-limited nutrients", () => {
    const element = MicronutrientChart({
      data: [
        {
          nutrientId: "vitamin_d",
          nutrient: "Vitamin D",
          unit: "mcg",
          intake: {
            totalDailyAverage: 120,
            foodDailyAverage: 20,
            providerDailyTotalAverage: 0,
            supplementDailyAverage: 100,
            daysTracked: 10,
          },
          sourceBreakdown: [],
          adequacy: {
            status: "at_or_above_daily_value",
            percentDailyValue: 600,
            message: "Target guidance from the server.",
            reference: {
              type: "daily_value",
              amount: 20,
              unit: "mcg",
              population: "Adults and children age 4+",
              source: {
                agency: "FDA",
                title: "Daily Value on the Nutrition and Supplement Facts Labels",
                url: "https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels",
                reviewedOn: "2026-07-27",
              },
            },
          },
          upperLimit: {
            status: "at_or_above_limit",
            amount: 100,
            unit: "mcg",
            intakeScope: "total",
            population: "U.S. adults age 19+",
            nutrientForm: "all tracked forms",
            intakeAmount: 120,
            source: {
              agency: "NIH ODS",
              title: "Vitamin D - Health Professional Fact Sheet",
              url: "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
              reviewedOn: "2026-07-27",
            },
            message: "Review this intake with a doctor or pharmacist.",
          },
          safetyStatus: "at_or_above_upper_limit",
        },
        {
          nutrientId: "vitamin_a",
          nutrient: "Vitamin A",
          unit: "mcg",
          intake: {
            totalDailyAverage: 3_500,
            foodDailyAverage: 3_000,
            providerDailyTotalAverage: 0,
            supplementDailyAverage: 500,
            daysTracked: 8,
          },
          sourceBreakdown: [],
          adequacy: null,
          upperLimit: {
            status: "not_evaluable",
            amount: 3_000,
            unit: "mcg",
            intakeScope: "total",
            population: "U.S. adults age 19+",
            nutrientForm: "preformed vitamin A",
            limitation:
              "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
            source: {
              agency: "NIH ODS",
              title: "Vitamin A and Carotenoids - Health Professional Fact Sheet",
              url: "https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/",
              reviewedOn: "2026-07-27",
            },
            message:
              "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
          },
          safetyStatus: "upper_limit_not_evaluable",
        },
      ],
      selectedWindowDays: 30,
    });

    const chartElement = findChartElement(element);
    const formatter = chartElement.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");
    const html = String(formatter([{ name: "Vitamin D", value: 600, dataIndex: 0 }]));

    expect(html).toContain("Target: 600% of U.S. Food and Drug Administration (FDA) Daily Value");
    expect(html).toContain("Tolerable Upper Intake Level (UL): 100 mcg/day for total daily intake");
    expect(html).toContain("UL status: At or above the Tolerable Upper Intake Level (UL)");
    expect(html).toContain("UL source: Vitamin D - Health Professional Fact Sheet");
    expect(html).toContain("average over 10 recorded days in a 30-day selected window");

    const text = elementText(element);
    expect(text).toContain("Vitamin D");
    expect(text).toContain("Vitamin A");
    expect(text).toContain("Target: No FDA Daily Value target is available for this nutrient.");
    expect(text).toContain("Tolerable Upper Intake Level (UL) not evaluable");
    expect(text).toContain("preformed vitamin A");
  });
});
