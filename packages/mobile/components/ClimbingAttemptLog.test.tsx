// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingAttemptLog } from "./ClimbingAttemptLog";

describe("mobile ClimbingAttemptLog", () => {
  it("submits ordered attempt outcomes and reasons", () => {
    const onSubmit = vi.fn();
    render(<ClimbingAttemptLog errorMessage={null} onSubmit={onSubmit} submitting={false} />);

    fireEvent.click(screen.getByLabelText("Grade (V Scale) V5"));
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

  it("uses the selected grade preference for manual logging", () => {
    const onSubmit = vi.fn();
    render(
      <ClimbingAttemptLog
        errorMessage={null}
        gradePreference={{ boulder: "font", route: "french" }}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );

    fireEvent.click(screen.getByLabelText("Grade (Fontainebleau) 6a"));
    fireEvent.click(screen.getByLabelText("Save climbing session"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        climbs: [expect.objectContaining({ grade: "6a", gradeSystem: "font" })],
      }),
    );
  });

  it("clears a selected grade when the climb type changes", () => {
    const onSubmit = vi.fn();
    render(<ClimbingAttemptLog errorMessage={null} onSubmit={onSubmit} submitting={false} />);

    fireEvent.click(screen.getByLabelText("Grade (V Scale) V5"));
    fireEvent.click(screen.getByLabelText("Climb type Route"));
    fireEvent.click(screen.getByLabelText("Save climbing session"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        climbs: [expect.objectContaining({ grade: "", gradeSystem: "yds" })],
      }),
    );
  });
});
