import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { PowerCurveChart } from "./PowerCurveChart.tsx";

interface ChartElementProps {
  option: {
    series: Array<{ name: string }>;
  };
}

describe("PowerCurveChart", () => {
  it("labels the fitted curve as the Critical Power model", () => {
    const element = PowerCurveChart({
      data: [{ durationSeconds: 300, label: "5min", bestPower: 350, activityDate: "2026-07-01" }],
      model: { cp: 300, wPrime: 20_000, r2: 0.95 },
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected PowerCurveChart to return a chart element");
    }

    expect(element.props.option.series.map((series) => series.name)).toContain(
      "Critical Power model (300W, anaerobic work capacity=20kJ)",
    );
  });
});
