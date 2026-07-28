/** @vitest-environment jsdom */
import { operationalStatusColors } from "@dofek/scoring/colors";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));

function BrokenView(): never {
  throw new Error("Dashboard rendering failed");
}

describe("ErrorBoundary", () => {
  it("renders an announced, visibly identified fallback with an accessible retry", () => {
    const onReset = vi.fn();
    render(
      <ErrorBoundary onReset={onReset}>
        <BrokenView />
      </ErrorBoundary>,
      { onCaughtError: () => {} },
    );

    const alert = screen.getByRole("alert");
    expect(screen.getByTestId("error-boundary-icon").textContent).toBe("!");
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toHaveStyle({
      color: operationalStatusColors.danger.foreground,
    });
    expect(alert).toHaveStyle({
      backgroundColor: operationalStatusColors.danger.surface,
      borderColor: operationalStatusColors.danger.border,
    });
    expect(screen.getByText("Dashboard rendering failed")).toHaveStyle({
      color: operationalStatusColors.danger.foreground,
    });

    const retryButton = screen.getByRole("button", { name: "Try again" });
    expect(retryButton).toHaveClass(
      "border",
      "hover:brightness-95",
      "focus-visible:outline",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
    );

    fireEvent.click(retryButton);
    expect(onReset).toHaveBeenCalledOnce();
  });
});
