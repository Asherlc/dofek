import { operationalStatusColors } from "@dofek/scoring/colors";
import { fireEvent, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { describe, expect, it } from "vitest";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard";

function cssRgb(hexColor: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hexColor.slice(start, start + 2), 16));
  return `rgb(${channels.join(", ")})`;
}

describe("SourceProcessingStatusCard", () => {
  it("discloses supporting details while keeping the summary and progress visible", () => {
    render(
      <SourceProcessingStatusCard
        heading="Updating activities, recovery, and training"
        message="Your existing data is still available."
        progress={60}
        status="active"
        details={<Text>Last ready: 5m ago</Text>}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show processing details", expanded: false });
    expect(screen.queryByText("Last ready: 5m ago")).toBeNull();
    expect(screen.getByText("Your existing data is still available.")).toBeTruthy();
    expect(screen.getByTestId("processing-status-progress")).toBeTruthy();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Hide processing details", expanded: true })).toBe(
      toggle,
    );
    expect(screen.getByText("Last ready: 5m ago")).toBeTruthy();

    fireEvent.click(toggle);

    expect(screen.queryByText("Last ready: 5m ago")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
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
        heading="Importing Apple Health is waiting to continue"
        message="Your existing data is still available."
        progress={null}
        status="blocked"
      />,
    );
    expect(screen.getByRole("summary").style.borderLeftColor).toBe(
      cssRgb(operationalStatusColors.warning.indicator),
    );

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
