import { operationalStatusColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard";

function cssRgb(hexColor: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hexColor.slice(start, start + 2), 16));
  return `rgb(${channels.join(", ")})`;
}

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

    expect(screen.getByText("Syncing Garmin")).toBeTruthy();
    expect(screen.getByText("Garmin")).toBeTruthy();
    expect(screen.getByTestId("processing-status-progress")).toBeTruthy();
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

    expect(screen.getByRole("summary").style.borderLeftColor).toBe(
      cssRgb(operationalStatusColors.danger.indicator),
    );
    expect(screen.getByText("Import failed")).toBeTruthy();

    rerender(
      <SourceProcessingStatusCard
        heading="Import complete"
        message={null}
        progress={null}
        status="ready"
      />,
    );
    expect(screen.getByRole("summary").style.borderLeftColor).toBe(
      cssRgb(operationalStatusColors.success.indicator),
    );
  });
});
