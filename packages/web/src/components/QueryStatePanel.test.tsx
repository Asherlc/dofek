/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel.tsx";

describe("getQueryErrorMessage", () => {
  it("returns the error message when an Error is provided", () => {
    expect(getQueryErrorMessage(new Error("Query failed"))).toBe("Query failed");
  });

  it("falls back when the error has no usable message", () => {
    expect(getQueryErrorMessage(new Error(""), "Fallback message")).toBe("Fallback message");
  });
});

describe("QueryStatePanel", () => {
  it("renders a loading skeleton for the loading variant", () => {
    const { container } = render(<QueryStatePanel variant="loading" message="Loading" />);
    expect(document.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector('[data-testid="query-state-loading"]')).toBeNull();
  });

  it("renders the error title and message", () => {
    render(<QueryStatePanel variant="error" message="Provider query failed" />);
    expect(screen.getByTestId("query-state-error")).toBeDefined();
    expect(screen.getByText("Could not load this section")).toBeDefined();
    expect(screen.getByText("Provider query failed")).toBeDefined();
  });

  it("renders the empty title and message", () => {
    render(<QueryStatePanel variant="empty" message="No entries for this day" />);
    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("No data yet")).toBeDefined();
    expect(screen.getByText("No entries for this day")).toBeDefined();
  });
});
