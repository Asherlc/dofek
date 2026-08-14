import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportRecoveryPanel } from "./ReportRecoveryPanel";

describe("ReportRecoveryPanel", () => {
  it("announces a stale report warning and offers both recovery actions", () => {
    const onRetry = vi.fn();
    const onReviewData = vi.fn();

    render(
      <ReportRecoveryPanel
        message="The weekly report could not be refreshed."
        onRetry={onRetry}
        onReviewData={onReviewData}
        preserved
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Showing the last available report");
    expect(alert.textContent).toContain("The weekly report could not be refreshed.");

    fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
    fireEvent.click(screen.getByRole("button", { name: "Review data alerts" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onReviewData).toHaveBeenCalledOnce();
  });

  it("disables retry while the report is refreshing", () => {
    render(
      <ReportRecoveryPanel
        message="The monthly report could not be refreshed."
        onRetry={vi.fn()}
        onReviewData={vi.fn()}
        retrying
      />,
    );

    expect(screen.getByRole("button", { name: "Retrying..." }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});
