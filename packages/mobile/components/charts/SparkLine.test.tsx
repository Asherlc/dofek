import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SparkLine } from "./SparkLine";

describe("SparkLine", () => {
  it.each([
    { data: [172], count: 1 },
    { data: [172, null, 180], count: 2 },
    { data: [0], count: 1 },
  ])("renders $count measured points for isolated observations $data", ({ data, count }) => {
    const { container } = render(<SparkLine data={data} width={140} height={40} />);
    const points = container.querySelectorAll("circle");
    expect(points).toHaveLength(count);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    for (const point of points) {
      expect(Number.isFinite(Number(point.getAttribute("cx")))).toBe(true);
      expect(Number.isFinite(Number(point.getAttribute("cy")))).toBe(true);
      expect(Number(point.getAttribute("cx"))).toBeGreaterThanOrEqual(3);
      expect(Number(point.getAttribute("cx"))).toBeLessThanOrEqual(137);
      expect(Number(point.getAttribute("cy"))).toBeGreaterThanOrEqual(3);
      expect(Number(point.getAttribute("cy"))).toBeLessThanOrEqual(37);
    }
  });

  it("renders separate line segments around unavailable values", () => {
    const { container } = render(
      <SparkLine data={[10, 20, null, 30, 40]} width={140} height={40} />,
    );

    expect(container.querySelectorAll("polyline")).toHaveLength(2);
  });

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
