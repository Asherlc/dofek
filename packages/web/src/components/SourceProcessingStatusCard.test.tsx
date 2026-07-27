/** @vitest-environment jsdom */
import { operationalStatusColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard.tsx";

describe("SourceProcessingStatusCard", () => {
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
