/** @vitest-environment jsdom */
import { operationalStatusColors } from "@dofek/scoring/colors";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard.tsx";

describe("SourceProcessingStatusCard", () => {
  it("discloses supporting details while keeping the summary and progress visible", () => {
    render(
      <SourceProcessingStatusCard
        heading="Updating activities, recovery, and training"
        message="Your existing data is still available."
        progress={60}
        status="active"
        details={<p>Last ready: 5m ago</p>}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show processing details", expanded: false });
    expect(screen.queryByText("Last ready: 5m ago")).toBeNull();
    expect(screen.getByText("Your existing data is still available.")).toBeVisible();
    expect(screen.getByRole("progressbar")).toBeVisible();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Hide processing details", expanded: true })).toBe(
      toggle,
    );
    expect(screen.getByText("Last ready: 5m ago")).toBeVisible();
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toContainElement(
      screen.getByText("Last ready: 5m ago"),
    );

    fireEvent.click(toggle);

    expect(screen.queryByText("Last ready: 5m ago")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows source progress in a full status card", () => {
    render(
      <SourceProcessingStatusCard
        contextLabel="Garmin"
        heading="Syncing Garmin"
        message={null}
        progress={60}
        status="active"
      />,
    );

    expect(screen.getByRole("heading", { name: "Syncing Garmin" })).toBeTruthy();
    expect(screen.getByText("Garmin").closest("section")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
  });

  it("maps processing outcomes to shared operational indicators", () => {
    const { rerender } = render(
      <SourceProcessingStatusCard
        heading="Import failed"
        message="Try again"
        progress={null}
        status="failed"
      />,
    );

    const failedCard = screen.getByRole("heading", { name: "Import failed" }).closest("section");
    expect(failedCard).not.toBeNull();
    expect(failedCard).toHaveStyle({
      borderLeftColor: operationalStatusColors.danger.indicator,
    });
    expect(screen.getByRole("heading", { name: "Import failed" })).toBeTruthy();

    rerender(
      <SourceProcessingStatusCard
        heading="Importing Apple Health is waiting to continue"
        message="Your existing data is still available."
        progress={null}
        status="blocked"
      />,
    );
    const blockedCard = screen
      .getByRole("heading", { name: "Importing Apple Health is waiting to continue" })
      .closest("section");
    expect(blockedCard).toHaveStyle({
      borderLeftColor: operationalStatusColors.warning.indicator,
    });

    rerender(
      <SourceProcessingStatusCard
        heading="Import complete"
        message={null}
        progress={null}
        status="ready"
      />,
    );
    const readyCard = screen.getByRole("heading", { name: "Import complete" }).closest("section");
    expect(readyCard).not.toBeNull();
    expect(readyCard).toHaveStyle({
      borderLeftColor: operationalStatusColors.success.indicator,
    });
  });
});
