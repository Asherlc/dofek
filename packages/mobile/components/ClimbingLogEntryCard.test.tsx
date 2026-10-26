import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
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
    const source = screen.getByRole("link", { name: "Mountain Project" });
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
          recordedClimbAttemptCount: null,
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
    expect(screen.queryByText(/Attempts:/)).toBeNull();
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
    expect(screen.getByRole("link", { name: "Mountain Project" })).toBeTruthy();
    expect(screen.getByText("5.4")).toBeTruthy();
    expect(screen.getByText("Sent")).toBeTruthy();
  });

  it("shows a known recorded attempt count alongside its outcome", () => {
    render(
      <ClimbingLogEntryCard
        entry={{ ...climbingLogFixture, providerId: "kaya", recordedClimbAttemptCount: 2 }}
      />,
    );
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("Attempts: 2")).toBeTruthy();
  });

  it.each([
    { freeSend: false, outcome: "completed", badge: "Completed" },
    { freeSend: false, outcome: "failed", badge: "Attempted" },
    { freeSend: null, outcome: "completed", badge: "Completed" },
    { freeSend: true, outcome: "completed", badge: null },
    { freeSend: false, outcome: null, badge: null },
    { freeSend: null, outcome: null, badge: null },
  ] as const)(
    "renders the server's send status ($freeSend, $outcome)",
    ({ freeSend, outcome, badge }) => {
      render(
        <ClimbingLogEntryCard
          entry={{
            ...climbingLogFixture,
            freeSend,
            recordedClimbOutcome: outcome,
            recordedClimbAttemptCount: 2,
            attempts: [climbingAttemptFixture(climbingLogFixture.id, { outcome })],
          }}
        />,
      );
      expect(screen.getByText("Attempts: 2")).toBeTruthy();
      if (badge !== null) expect(screen.getByText(badge)).toBeTruthy();
      expect(screen.queryAllByText("Attempted")).toHaveLength(badge === "Attempted" ? 1 : 0);
      expect(screen.queryAllByText("Completed")).toHaveLength(badge === "Completed" ? 1 : 0);
    },
  );

  it.each([
    { number: 2, name: "Crux", expected: "Pitch 2" },
    { number: null, name: "Crux", expected: "Crux" },
    { number: null, name: null, expected: "Pitch" },
  ])("keeps $expected context separate from its attempted badge", ({ number, name, expected }) => {
    const climb = climbingClimbFixture();
    const pitch = {
      id: "20000000-0000-4000-8000-000000000020",
      climbId: climb.id,
      externalId: null,
      number,
      name,
      publishedGrades: [],
    };
    const attempt = climbingAttemptFixture(climbingLogFixture.id, {
      scope: "pitch",
      pitchId: pitch.id,
      outcome: "failed",
      ropeMethod: "lead",
    });
    render(
      <ClimbingLogEntryCard
        entry={{
          ...climbingLogFixture,
          climbId: climb.id,
          climb: { ...climb, pitches: [pitch] },
          recordedClimbAttemptCount: 0,
          recordedClimbOutcome: null,
          recordedPitchAttemptCount: 1,
          attempts: [attempt],
          pitchResults: [
            {
              pitch,
              attemptIds: [attempt.id],
              recordedOutcome: "failed",
              recordedAttemptCount: 1,
              displayGrade: null,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(`${expected} · Attempts: 1`)).toBeTruthy();
    expect(screen.getByText("Attempted")).toBeTruthy();
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

it.each(["Onsight", "Flash"] as const)(
  "labels an unnamed colored Kaya boulder and keeps only %s",
  (label) => {
    const entry = {
      ...climbingLogFixture,
      providerId: "kaya",
      title: null,
      sourceLinks: [],
      climb: { ...climbingClimbFixture("kaya"), name: null, kind: "boulder" as const },
      raw: { color: { name: "Blue" } },
      displayGrade: "V5",
      freeSend: true,
      recordedClimbAttemptCount: 1,
      attempts: [
        climbingAttemptFixture(climbingLogFixture.id, { rockResultLabels: ["sent", label] }),
      ],
    };
    render(<ClimbingLogEntryCard entry={entry} />);
    expect(screen.getByText("Blue boulder")).toBeTruthy();
    expect(screen.getByText("V5")).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/Attempts:|completed/i)).toBeNull();
  },
);
