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
          nutrient: '<img src=x onerror="alert(1)">',
          unit: '<svg onload="alert(1)">',
          rda: 10,
          avgIntake: 5,
          percentRda: 50,
          daysTracked: 7,
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

  it("expands Recommended Dietary Allowance in the tooltip and target marker", () => {
    const element = MicronutrientChart({
      data: [
        {
          nutrient: "Iron",
          unit: "mg",
          rda: 18,
          avgIntake: 12,
          percentRda: 67,
          daysTracked: 7,
        },
      ],
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected MicronutrientChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(formatter([{ name: "Iron", value: 67, dataIndex: 0 }]));

    expect(html).toContain("67% of Recommended Dietary Allowance (RDA)");
    expect(element.props.option.series?.[0]?.markLine?.label?.formatter).toBe(
      "100% Recommended Dietary Allowance (RDA)",
    );
  });
});
