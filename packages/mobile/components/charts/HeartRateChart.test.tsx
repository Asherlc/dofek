import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeartRateChart } from "./HeartRateChart";

describe("HeartRateChart", () => {
  it("renders nothing with fewer than 2 data points", () => {
    const { container } = render(<HeartRateChart data={[72]} width={300} height={150} />);

    expect(container.querySelector("polyline")).toBeNull();
  });

  it("renders a polyline when given enough data", () => {
    const { container } = render(
      <HeartRateChart data={[65, 68, 72, 70, 74]} width={300} height={150} />,
    );

    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute("stroke")).toBe("#ff453a");
  });

  it("clamps values to domain range", () => {
    // Values outside 30-220 should be clamped, not cause rendering issues
    const { container } = render(
      <HeartRateChart data={[20, 250, 100, 80]} width={300} height={150} />,
    );

    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
  });

  it("renders horizontal grid lines", () => {
    const { container } = render(
      <HeartRateChart data={[65, 68, 72, 70, 74]} width={300} height={150} />,
    );

    const lines = container.querySelectorAll("line");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("uses custom color when provided", () => {
    const { container } = render(
      <HeartRateChart data={[65, 68, 72]} width={300} height={150} color="#00ff00" />,
    );

    const polyline = container.querySelector("polyline");
    expect(polyline?.getAttribute("stroke")).toBe("#00ff00");
  });
});
