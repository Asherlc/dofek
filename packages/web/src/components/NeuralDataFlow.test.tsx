// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NeuralDataFlow } from "./NeuralDataFlow.tsx";

afterEach(cleanup);

describe("NeuralDataFlow", () => {
  it("exposes an accessible name for the diagram", () => {
    render(<NeuralDataFlow />);

    expect(
      screen.getByRole("img", {
        name: /health sources flow into Dofek and insights flow out/i,
      }),
    ).toBeTruthy();
  });

  it("labels inbound sources and outbound insights", () => {
    render(<NeuralDataFlow />);

    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("Heart rate")).toBeTruthy();
    expect(screen.getByText("Training")).toBeTruthy();
    expect(screen.getByText("Nutrition")).toBeTruthy();
    expect(screen.getByText("Trends")).toBeTruthy();
    expect(screen.getByText("Correlations")).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
  });
});
