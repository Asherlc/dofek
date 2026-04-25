import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

describe("getQueryErrorMessage", () => {
  it("returns the error message when an Error is provided", () => {
    expect(getQueryErrorMessage(new Error("Network failed"))).toBe("Network failed");
  });

  it("falls back when no usable error message exists", () => {
    expect(getQueryErrorMessage(new Error(""), "Fallback message")).toBe("Fallback message");
  });
});

describe("QueryStatePanel", () => {
  it("renders a loading spinner", () => {
    render(<QueryStatePanel variant="loading" message="Loading" />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("renders the error title and message", () => {
    render(<QueryStatePanel variant="error" message="Provider query failed" />);
    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(screen.getByText("Could not load this section")).toBeTruthy();
    expect(screen.getByText("Provider query failed")).toBeTruthy();
  });

  it("renders the empty title and message", () => {
    render(<QueryStatePanel variant="empty" message="No entries yet" />);
    expect(screen.getByTestId("query-state-empty")).toBeTruthy();
    expect(screen.getByText("No data yet")).toBeTruthy();
    expect(screen.getByText("No entries yet")).toBeTruthy();
  });
});
