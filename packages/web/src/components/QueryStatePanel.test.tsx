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

  it("disables the retry action while a refetch is in flight", () => {
    const onRetry = vi.fn();
    render(
      <QueryStatePanel error={new Error("Provider query failed")} onRetry={onRetry} retrying />,
    );

    const retryButton = screen.getByRole("button", { name: "Retrying..." });
    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    if (!(retryButton instanceof HTMLButtonElement)) {
      throw new Error("Expected retry button");
    }
    expect(retryButton.disabled).toBe(true);
    fireEvent.click(retryButton);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
