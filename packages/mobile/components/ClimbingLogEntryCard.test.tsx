import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { climbingAttemptFixture } from "../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryCard } from "./ClimbingLogEntryCard";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";

describe("ClimbingLogEntryCard", () => {
  it("announces selection on the climb link while retaining the source and Attach actions", () => {
    const onAttach = vi.fn();
    const { rerender } = render(
      <ClimbingLogEntryCard entry={climbingLogFixture} selected onAttach={onAttach} />,
    );
    const climb = screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" });
    expect(climb.getAttribute("data-accessible")).toBe("true");
    expect(climb.getAttribute("aria-selected")).toBe("true");
    climb.focus();
    expect(document.activeElement).toBe(climb);
    const source = screen.getByRole("link", { name: "Mountain Project ticks" });
    source.focus();
    expect(document.activeElement).toBe(source);
    fireEvent.click(screen.getByRole("button", { name: "Attach Swiss Cheese to this activity" }));
    expect(onAttach).toHaveBeenCalledWith(climbingLogFixture.id);
    rerender(<ClimbingLogEntryCard entry={climbingLogFixture} selected={false} />);
    expect(climb.getAttribute("aria-selected")).toBe("false");
  });

  it("announces selection on an accessible climb name without source links", () => {
    render(<ClimbingLogEntryCard entry={{ ...climbingLogFixture, sourceLinks: [] }} selected />);
    const climb = screen.getByText("Swiss Cheese");
    expect(climb.getAttribute("data-accessible")).toBe("true");
    expect(climb.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the recorded top-rope method when the source omits a completion result", () => {
    if (!climbingLogFixture.climb) throw new Error("Expected a named climb fixture");
    render(
      <ClimbingLogEntryCard
        entry={{
          ...climbingLogFixture,
          climb: { ...climbingLogFixture.climb, name: "Havarti Cheese" },
          recordedClimbOutcome: null,
          recordedClimbAttemptCount: 1,
          attempts: [
            climbingAttemptFixture(climbingLogFixture.id, {
              ropeMethod: "top_rope",
              outcome: null,
            }),
          ],
        }}
      />,
    );
    expect(screen.getByText("Havarti Cheese")).toBeTruthy();
    expect(screen.getByText("Top rope")).toBeTruthy();
    expect(screen.getByText("Attempts: 1")).toBeTruthy();
  });

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

  it("preserves source links, climbing context and recorded attempt summary", () => {
    render(<ClimbingLogEntryCard entry={climbingLogFixture} />);
    expect(screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mountain Project ticks" })).toBeTruthy();
    expect(screen.getByText("5.4")).toBeTruthy();
    expect(screen.getByText("Completed · Attempts: 2")).toBeTruthy();
  });

  it("shows a compact single-point map", () => {
    const { container } = render(
      <ClimbingLogEntryCard entry={climbingLogFixture} location={exactClimbingLocation} />,
    );
    expect(container.querySelector("mapview")).toBeNull();
    const wrapper = container.querySelector('[style*="overflow: hidden"]')?.firstElementChild;
    if (!wrapper) throw new Error("Expected the compact map layout wrapper");
    fireEvent(wrapper, new CustomEvent("layout", { detail: { width: 280, height: 140 } }));
    const map = container.querySelector("mapview");
    expect(map?.getAttribute("style")).toContain("height: 140px");
    expect(container.querySelectorAll("marker")).toHaveLength(1);
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector('[title="Start"]')).toBeNull();
    expect(container.querySelector('[title="Finish"]')).toBeNull();
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
