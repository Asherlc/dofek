/** @vitest-environment jsdom */
import { operationalStatusColors } from "@dofek/scoring/colors";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

function relativeLuminance(hexColor: string): number {
  const linearChannel = (start: number) => {
    const channel = Number.parseInt(hexColor.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("QueryStatePanel", () => {
  it("does not use error styling for loading state", () => {
    render(<QueryStatePanel variant="loading" />);
    expect(screen.getByTestId("query-state-loading").className).not.toContain("query-error-panel");
  });

  it("announces a named busy loading status", () => {
    render(<QueryStatePanel variant="loading" message="Loading behavior associations." />);

    const status = screen.getByRole("status", { name: "Loading behavior associations." });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("renders the error message", () => {
    render(<QueryStatePanel error={new Error("Provider query failed")} />);
    expect(screen.getByText("Provider query failed")).toBeDefined();
  });

  it("renders structured empty-state guidance", () => {
    render(
      <QueryStatePanel
        variant="empty"
        message={
          <span>
            <span>2 of 3 metrics are available.</span>
            <span>Sync one more metric.</span>
          </span>
        }
      />,
    );

    expect(screen.getByText("2 of 3 metrics are available.")).toBeDefined();
    expect(screen.getByText("Sync one more metric.")).toBeDefined();
  });

  it("renders an announced, visibly identified error with AA contrast", () => {
    render(<QueryStatePanel error={new Error("Provider query failed")} />);

    const panel = screen.getByRole("alert");
    const title = screen.getByRole("heading", { name: "Could not load this section" });
    const message = screen.getByText("Provider query failed");

    expect(screen.getByTestId("query-state-error-icon").textContent).toBe("!");
    expect(panel).toHaveStyle({
      backgroundColor: operationalStatusColors.danger.surface,
      borderColor: operationalStatusColors.danger.border,
    });
    expect(title).toHaveStyle({ color: operationalStatusColors.danger.foreground });
    expect(message).toHaveStyle({ color: operationalStatusColors.danger.foreground });
    expect(
      contrastRatio(
        operationalStatusColors.danger.foreground,
        operationalStatusColors.danger.surface,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(operationalStatusColors.danger.border, operationalStatusColors.danger.surface),
    ).toBeGreaterThanOrEqual(3);
  });

  it("names and visibly identifies a contextual error without nesting alerts", () => {
    render(
      <QueryStatePanel contextLabel="Sleep" error={new Error("Sleep performance unavailable")} />,
    );

    const heading = screen.getByRole("heading", {
      name: "Sleep: Could not load this section",
    });
    const alert = heading.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent("Sleep: Could not load this section");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("uses a domain-specific error title when provided", () => {
    render(
      <QueryStatePanel
        error={new Error("Status service timed out")}
        title="Alert status is unavailable"
      />,
    );

    expect(screen.getByRole("heading", { name: "Alert status is unavailable" })).toBeDefined();
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
