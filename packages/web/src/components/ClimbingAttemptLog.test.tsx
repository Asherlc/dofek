/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingAttemptLog } from "./ClimbingAttemptLog.tsx";

describe("ClimbingAttemptLog", () => {
  it("adds ordered attempts and submits per-attempt outcomes", () => {
    const onSubmit = vi.fn();
    render(<ClimbingAttemptLog errorMessage={null} onSubmit={onSubmit} submitting={false} />);

    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "V5" } });
    fireEvent.change(screen.getByLabelText("Attempt 1 failure reason"), {
      target: { value: "technique" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add climbing attempt" }));
    fireEvent.change(screen.getByLabelText("Attempt 2 outcome"), {
      target: { value: "sent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save climbing session" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        climbs: [
          expect.objectContaining({
            attempts: [
              { failureReason: "technique", notes: null, outcome: "failed" },
              { failureReason: null, notes: null, outcome: "sent" },
            ],
            grade: "V5",
          }),
        ],
        startedAt: expect.any(String),
      }),
    );
  });

  it("submits an empty wall angle as null", () => {
    const onSubmit = vi.fn();
    render(<ClimbingAttemptLog errorMessage={null} onSubmit={onSubmit} submitting={false} />);

    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "V5" } });
    fireEvent.change(screen.getByLabelText("Wall angle (degrees; positive is overhang)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save climbing session" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        climbs: [expect.objectContaining({ wallAngleDegrees: null })],
      }),
    );
  });
});
