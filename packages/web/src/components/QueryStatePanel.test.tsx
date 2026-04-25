/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

describe("QueryStatePanel", () => {
  it("renders the error message", () => {
    render(<QueryStatePanel error={new Error("Provider query failed")} />);
    expect(screen.getByText("Provider query failed")).toBeDefined();
  });

  it("falls back when the error has no usable message", () => {
    render(<QueryStatePanel error={new Error("")} />);
    expect(screen.getByText("Failed to load data.")).toBeDefined();
  });
});
