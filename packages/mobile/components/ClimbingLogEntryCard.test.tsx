import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingLogEntryCard } from "./ClimbingLogEntryCard";
import {
  areaClimbingLocation,
  climbingLogFixture,
  exactClimbingLocation,
} from "./climbing-log-entry-fixtures";

describe("ClimbingLogEntryCard", () => {
  it("exposes a pending attachment as busy and disabled to assistive technology", () => {
    const onAttach = vi.fn();
    render(
      <ClimbingLogEntryCard
        entry={climbingLogFixture}
        onAttach={onAttach}
        attachmentState={{ pending: true, error: null }}
      />,
    );
    const control = screen.getByText("Attaching...").closest("button");
    expect(control?.getAttribute("aria-busy")).toBe("true");
    expect(control?.getAttribute("aria-disabled")).toBe("true");
    if (!control) throw new Error("Expected an Attach control");
    fireEvent.click(control);
    expect(onAttach).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "Attach Swiss Cheese to this activity"],
    [3, "Attach entry 3, Swiss Cheese to this activity"],
  ] as const)(
    "identifies an available Attach action by name and optional ordinal (%s)",
    (entryNumber, accessibleName) => {
      const onAttach = vi.fn();
      render(
        <ClimbingLogEntryCard
          entry={climbingLogFixture}
          entryNumber={entryNumber}
          onAttach={onAttach}
        />,
      );
      const control = screen.getByRole("button", { name: accessibleName });
      expect(control.getAttribute("aria-busy")).toBe("false");
      expect(control.getAttribute("aria-disabled")).toBe("false");
      fireEvent.click(control);
      expect(onAttach).toHaveBeenCalledWith("tick-1");
    },
  );

  it("preserves source links, climbing context and attached attempt details", () => {
    render(<ClimbingLogEntryCard entry={climbingLogFixture} />);
    expect(screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mountain Project ticks" })).toBeTruthy();
    expect(screen.getByText("Goat Rock")).toBeTruthy();
    expect(screen.getByText("5.4")).toBeTruthy();
    expect(screen.getByText("Whole climb completed · 2 recorded attempts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details for Swiss Cheese" }));
    expect(screen.getByText("Recorded attempts")).toBeTruthy();
  });

  it("shows explicit exact-location provenance and a compact single-point map", () => {
    const { container } = render(
      <ClimbingLogEntryCard entry={climbingLogFixture} location={exactClimbingLocation} />,
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
    render(<ClimbingLogEntryCard entry={climbingLogFixture} location={areaClimbingLocation} />);
    expect(screen.getByText("Area location: Goat Rock · OpenBeta")).toBeTruthy();
  });

  it("keeps the retry action available after an attachment error", () => {
    const onAttach = vi.fn();
    render(
      <ClimbingLogEntryCard
        entry={climbingLogFixture}
        attachmentState={{ pending: false, error: "Refresh this activity and try again." }}
        onAttach={onAttach}
      />,
    );
    expect(screen.getByText("Refresh this activity and try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attach Swiss Cheese to this activity" }));
    expect(onAttach).toHaveBeenCalledWith("tick-1");
  });
});
