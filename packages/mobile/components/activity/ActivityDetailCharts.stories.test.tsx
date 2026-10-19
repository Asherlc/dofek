import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MetricSources } from "./ActivityDetailCharts.stories";

vi.mock("./useChartScrub", () => ({
  useChartScrub: () => ({
    touchIndex: null,
    panResponder: { panHandlers: {} },
  }),
}));

describe("MetricSources preview", () => {
  it("announces visibility and preserves it when choosing a source", () => {
    render(<MetricSources.render />);
    const power = screen.getByRole("button", { name: "Toggle Power" });
    expect(power.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(power);
    expect(power.getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("button", { name: "View Power data" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Power source: Automatic, Wahoo" }));
    fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
    expect(screen.getByRole("button", { name: "Power source: Garmin" })).toBeDefined();
    expect(power.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(power);
    expect(power.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "View Power data" }));
    expect(screen.getAllByText("199 W").length).toBeGreaterThan(0);
  });
});
