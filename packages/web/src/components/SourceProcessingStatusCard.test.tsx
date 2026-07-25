/** @vitest-environment jsdom */
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
});
