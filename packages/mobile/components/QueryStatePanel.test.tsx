import { operationalStatusColors } from "@dofek/scoring/colors";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fontSize, fontWeight, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

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

function cssRgb(hexColor: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hexColor.slice(start, start + 2), 16));
  return `rgb(${channels.join(", ")})`;
}

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
    const panel = screen.getByRole("alert");
    const title = screen.getByText("Could not load this section");
    const message = screen.getByText("Provider query failed");

    expect(screen.getByTestId("query-state-error-icon").textContent).toBe("!");
    expect(panel.style.backgroundColor).toBe(cssRgb(operationalStatusColors.danger.surface));
    expect(panel.style.borderColor).toBe(cssRgb(operationalStatusColors.danger.border));
    expect(title.style.color).toBe(cssRgb(operationalStatusColors.danger.foreground));
    expect(message.style.color).toBe(cssRgb(operationalStatusColors.danger.foreground));
    expect(title.style.fontSize).toBe(`${fontSize.base}px`);
    expect(title.style.fontWeight).toBe(fontWeight.bold);
    const errorIcon = screen.getByTestId("query-state-error-icon");
    expect(errorIcon.style.fontSize).toBe(`${fontSize.base}px`);
    expect(errorIcon.style.fontWeight).toBe(fontWeight.extrabold);
    expect(errorIcon.style.height).toBe(`${spacing.lg}px`);
    expect(errorIcon.style.lineHeight).toBe(`${spacing.lg}`);
    expect(errorIcon.style.width).toBe(`${spacing.lg}px`);
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

  it("offers an accessible retry action for recoverable errors", () => {
    const onRetry = vi.fn();
    render(
      <QueryStatePanel
        variant="error"
        message="Provider query failed"
        onRetry={onRetry}
        retryLabel="Retry providers"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry providers" }));

    expect(onRetry).toHaveBeenCalledOnce();
    const retryText = screen.getByText("Retry providers");
    expect(retryText.style.fontSize).toBe(`${fontSize.xs}px`);
    expect(retryText.style.fontWeight).toBe(fontWeight.bold);
  });

  it("disables retry while a refresh is in flight", () => {
    const onRetry = vi.fn();
    render(
      <QueryStatePanel
        variant="error"
        message="Provider query failed"
        onRetry={onRetry}
        retrying
      />,
    );

    const retryButton = screen.getByRole("button", { name: "Retrying..." });
    expect(retryButton.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(retryButton);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders the empty title and message", () => {
    render(<QueryStatePanel variant="empty" message="No entries yet" />);
    expect(screen.getByTestId("query-state-empty")).toBeTruthy();
    expect(screen.getByText("No data yet")).toBeTruthy();
    expect(screen.getByText("No entries yet")).toBeTruthy();
  });
});
