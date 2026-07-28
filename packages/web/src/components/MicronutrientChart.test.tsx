/** @vitest-environment jsdom */

import { isValidElement } from "react";
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
            supplementDailyAverage: 0,
            daysTracked: 7,
          },
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
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected MicronutrientChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(formatter([{ name: "", value: 50, dataIndex: 0 }]));

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;");
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
            supplementDailyAverage: 0,
            daysTracked: 7,
          },
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
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected MicronutrientChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(formatter([{ name: "Iron", value: 67, dataIndex: 0 }]));

    expect(html).toContain("67% of FDA Daily Value (adequacy reference, not a safety rating)");
    expect(html).toContain("average over 7 recorded days");
    expect(element.props.option.series?.[0]?.markLine?.label?.formatter).toBe(
      "100% FDA Daily Value",
    );
  });
});
