import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";

describe("ChartDescriptionTooltip", () => {
  it("renders a labeled 44-point control", () => {
    render(
      <ChartDescriptionTooltip
        title="Ramp Rate"
        description="Weekly change in training load; positive values are increases."
      />,
    );

    const button = screen.getByRole("button", { name: "About Ramp Rate" });
    const label = screen.getByText("About");
    expect(button.style.minWidth).toBe("44px");
    expect(button.style.minHeight).toBe("44px");
    expect(button.getAttribute("aria-description")).toBe(
      "Weekly change in training load; positive values are increases.",
    );

    fireEvent.mouseDown(button);
    expect(label.style.opacity).toBe("0.7");
    fireEvent.mouseUp(button);
    expect(label.style.opacity).toBe("");
  });

  it("opens an explicitly dismissible alert with the chart description", () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

    render(
      <ChartDescriptionTooltip
        title="Ramp Rate"
        description="Weekly change in training load; positive values are increases."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "About Ramp Rate" }));
    expect(alertSpy).toHaveBeenCalledWith(
      "Ramp Rate",
      "Weekly change in training load; positive values are increases.",
      [{ text: "Close" }],
    );

    alertSpy.mockRestore();
  });
});
