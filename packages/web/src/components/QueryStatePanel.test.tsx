/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

describe("QueryStatePanel", () => {
  it("does not use error styling for loading state", () => {
    render(<QueryStatePanel variant="loading" />);
    expect(screen.getByTestId("query-state-loading").className).not.toContain("query-error-panel");
  });

  it("renders the error message", () => {
    render(<QueryStatePanel error={new Error("Provider query failed")} />);
    expect(screen.getByText("Provider query failed")).toBeDefined();
  });

  it("falls back when the error has no usable message", () => {
    render(<QueryStatePanel error={new Error("")} />);
    expect(screen.getByText("Failed to load data.")).toBeDefined();
  });

  it("offers a retry action for recoverable query failures", () => {
    const onRetry = vi.fn();
    render(
      <QueryStatePanel
        error={new Error("Provider query failed")}
        onRetry={onRetry}
        retryLabel="Retry providers"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry providers" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
