import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";

describe("ChartDescriptionTooltip", () => {
  it("opens an alert with the chart description", () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

    render(
      <ChartDescriptionTooltip
        title="Ramp Rate"
        description="This chart shows how quickly your training load is changing week to week."
      />,
    );

    fireEvent.click(screen.getByLabelText("Chart info for Ramp Rate"));
    expect(alertSpy).toHaveBeenCalledWith(
      "Ramp Rate",
      "This chart shows how quickly your training load is changing week to week.",
    );

    alertSpy.mockRestore();
  });
});
