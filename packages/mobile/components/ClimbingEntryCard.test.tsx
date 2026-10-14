import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingEntryCard } from "./ClimbingEntryCard";
import {
  areaClimbingLocation,
  climbingEntryFixture,
  exactClimbingLocation,
} from "./climbing-entry-fixtures";

describe("ClimbingEntryCard", () => {
  it("preserves source links, climbing context and attached attempt details", () => {
    render(<ClimbingEntryCard entry={climbingEntryFixture} />);
    expect(screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mountain Project ticks" })).toBeTruthy();
    expect(screen.getByText("California > Goat Rock")).toBeTruthy();
    expect(screen.getByText("Lead")).toBeTruthy();
    expect(screen.getByText("5.4")).toBeTruthy();
    expect(screen.getByText("Crimp")).toBeTruthy();
    expect(screen.getByText("1: Technique")).toBeTruthy();
    expect(screen.getByText("2 attempts")).toBeTruthy();
  });

  it("shows explicit exact-location provenance and a compact single-point map", () => {
    const { container } = render(
      <ClimbingEntryCard entry={climbingEntryFixture} location={exactClimbingLocation} />,
    );
    expect(screen.getByText("Climb location: Swiss Cheese · Mountain Project")).toBeTruthy();
    expect(container.querySelector("mapview")).toBeNull();
    const wrapper = screen.getByText("Climb location: Swiss Cheese · Mountain Project")
      .parentElement?.lastElementChild?.lastElementChild;
    if (!wrapper) throw new Error("Expected the compact map layout wrapper");
    fireEvent(wrapper, new CustomEvent("layout", { detail: { width: 280, height: 140 } }));
    const map = container.querySelector("mapview");
    expect(map?.getAttribute("style")).toContain("height: 140px");
    expect(container.querySelectorAll("marker")).toHaveLength(1);
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector('[title="Start"]')).toBeNull();
    expect(container.querySelector('[title="Finish"]')).toBeNull();
  });

  it("labels the owning area and provider without implying an exact climb location", () => {
    render(<ClimbingEntryCard entry={climbingEntryFixture} location={areaClimbingLocation} />);
    expect(screen.getByText("Area location: Goat Rock · OpenBeta")).toBeTruthy();
  });

  it("keeps the retry action available after an attachment error", () => {
    const onAttach = vi.fn();
    render(
      <ClimbingEntryCard
        entry={climbingEntryFixture}
        attachmentState={{ pending: false, error: "Refresh this activity and try again." }}
        onAttach={onAttach}
      />,
    );
    expect(screen.getByText("Refresh this activity and try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attach to this activity" }));
    expect(onAttach).toHaveBeenCalledWith("tick-1");
  });
});
