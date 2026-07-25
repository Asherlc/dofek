import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard";

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
});
