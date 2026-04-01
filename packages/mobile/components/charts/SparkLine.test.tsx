import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SparkLine } from "./SparkLine";

describe("SparkLine", () => {
  it("renders background threshold bands when provided", () => {
    const { container } = render(
      <SparkLine
        data={[35, 55, 78]}
        width={140}
        height={40}
        color="#4a6a4a"
        domain={{ min: 0, max: 100 }}
        backgroundBands={[
          { min: 0, max: 50, color: "#dc262620" },
          { min: 50, max: 70, color: "#ca8a0420" },
          { min: 70, max: 100, color: "#16a34a20" },
        ]}
      />,
    );

    const bandRects = container.querySelectorAll("rect");
    expect(bandRects).toHaveLength(3);
  });

  it("keeps chart line neutral while rendering threshold bands", () => {
    const neutralLineColor = "#4a6a4a";
    const { container } = render(
      <SparkLine
        data={[35, 55, 78]}
        width={140}
        height={40}
        color={neutralLineColor}
        domain={{ min: 0, max: 100 }}
        backgroundBands={[
          { min: 0, max: 50, color: "#dc262620" },
          { min: 50, max: 70, color: "#ca8a0420" },
          { min: 70, max: 100, color: "#16a34a20" },
        ]}
      />,
    );

    const firstPolyline = container.querySelector("polyline");
    expect(firstPolyline?.getAttribute("stroke")).toBe(neutralLineColor);
  });
});
