// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingAttemptLog } from "./ClimbingAttemptLog";

describe("mobile ClimbingAttemptLog", () => {
  it("submits ordered attempt outcomes and reasons", () => {
    const onSubmit = vi.fn();
    render(<ClimbingAttemptLog errorMessage={null} onSubmit={onSubmit} submitting={false} />);

    const gradeInput = screen.getAllByRole("textbox")[0];
    if (!gradeInput) throw new Error("Grade input is required");
    fireEvent.change(gradeInput, { target: { value: "V5" } });
    fireEvent.click(screen.getByLabelText("Attempt 1 reason Technique"));
    fireEvent.click(screen.getByLabelText("Add climbing attempt"));
    fireEvent.click(screen.getByLabelText("Attempt 2 outcome Sent"));
    fireEvent.click(screen.getByLabelText("Save climbing session"));

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
      }),
    );
  });
});
