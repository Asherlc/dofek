// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";

describe("ChartDescriptionTooltip", () => {
  it("renders an info marker with tooltip text", () => {
    render(<ChartDescriptionTooltip description="This chart shows your weekly training load." />);

    const marker = screen.getByText("i");
    expect(marker.getAttribute("title")).toBe("This chart shows your weekly training load.");
  });

  it("applies custom classes", () => {
    render(<ChartDescriptionTooltip description="Chart info" className="my-custom-class" />);

    const marker = screen.getByText("i");
    expect(marker.className).toContain("my-custom-class");
  });
});
