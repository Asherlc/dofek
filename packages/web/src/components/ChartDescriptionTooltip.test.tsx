// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";

describe("ChartDescriptionTooltip", () => {
  it("renders an info marker with tooltip text", () => {
    render(<ChartDescriptionTooltip description="This chart shows your weekly training load." />);

    const marker = screen.getByText("i");
    expect(marker).toBeTruthy();

    // Tooltip text is rendered in the DOM (visible on hover via CSS)
    expect(screen.getByText("This chart shows your weekly training load.")).toBeTruthy();
  });

  it("applies custom classes", () => {
    render(<ChartDescriptionTooltip description="Chart info" className="my-custom-class" />);

    // The wrapper should contain the custom class
    const tooltip = screen.getByText("Chart info");
    expect(tooltip.closest(".my-custom-class")).toBeTruthy();
  });

  it("tooltip text has role=tooltip for accessibility", () => {
    render(<ChartDescriptionTooltip description="Chart info" />);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toBe("Chart info");
  });
});
