/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartContainer } from "./ChartContainer.tsx";

describe("ChartContainer", () => {
  it("shows loading skeleton when loading is true", () => {
    render(
      <ChartContainer loading={true} data={[]}>
        <div data-testid="chart">Chart</div>
      </ChartContainer>,
    );
    // Should not render children
    expect(screen.queryByTestId("chart")).toBeNull();
    // Should show the spinner from ChartLoadingSkeleton
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("uses custom height for loading skeleton", () => {
    const { container } = render(
      <ChartContainer loading={true} data={[]} height={400}>
        <div>Chart</div>
      </ChartContainer>,
    );
    const skeleton = container.firstElementChild;
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("style")).toContain("height");
  });

  it("shows empty message when data is empty and not loading", () => {
    render(
      <ChartContainer loading={false} data={[]}>
        <div data-testid="chart">Chart</div>
      </ChartContainer>,
    );
    expect(screen.queryByTestId("chart")).toBeNull();
    expect(screen.getByText("No data available")).toBeDefined();
  });

  it("shows custom empty message", () => {
    render(
      <ChartContainer loading={false} data={[]} emptyMessage="No sleep data">
        <div data-testid="chart">Chart</div>
      </ChartContainer>,
    );
    expect(screen.getByText("No sleep data")).toBeDefined();
  });

  it("renders children when data is present and not loading", () => {
    render(
      <ChartContainer loading={false} data={[{ value: 1 }]}>
        <div data-testid="chart">Chart</div>
      </ChartContainer>,
    );
    expect(screen.getByTestId("chart")).toBeDefined();
  });

  it("renders children when loading is false and data has elements", () => {
    render(
      <ChartContainer loading={false} data={[1, 2, 3]}>
        <div data-testid="my-chart">My Chart Content</div>
      </ChartContainer>,
    );
    expect(screen.getByTestId("my-chart")).toBeDefined();
    expect(screen.getByText("My Chart Content")).toBeDefined();
  });

  it("uses default height of 300 for empty state", () => {
    const { container } = render(
      <ChartContainer loading={false} data={[]}>
        <div>Chart</div>
      </ChartContainer>,
    );
    const emptyDiv = container.querySelector(".flex.items-center.justify-center");
    expect(emptyDiv).not.toBeNull();
    expect(emptyDiv).toBeInstanceOf(HTMLElement);
    if (emptyDiv instanceof HTMLElement) {
      expect(emptyDiv.style.height).toBe("300px");
    }
  });

  it("uses custom height for empty state", () => {
    const { container } = render(
      <ChartContainer loading={false} data={[]} height={450}>
        <div>Chart</div>
      </ChartContainer>,
    );
    const emptyDiv = container.querySelector(".flex.items-center.justify-center");
    expect(emptyDiv).not.toBeNull();
    expect(emptyDiv).toBeInstanceOf(HTMLElement);
    if (emptyDiv instanceof HTMLElement) {
      expect(emptyDiv.style.height).toBe("450px");
    }
  });

  it("prioritizes loading state over empty state", () => {
    render(
      <ChartContainer loading={true} data={[]}>
        <div data-testid="chart">Chart</div>
      </ChartContainer>,
    );
    // Should show loading, not empty message
    expect(screen.queryByText("No data available")).toBeNull();
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });
});
