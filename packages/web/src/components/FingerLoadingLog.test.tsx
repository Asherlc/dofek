/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FingerLoadingLog } from "./FingerLoadingLog.tsx";

describe("FingerLoadingLog", () => {
  it("presets the last protocol and submits a new timestamped raw entry", () => {
    const onSubmit = vi.fn();
    render(
      <FingerLoadingLog
        errorMessage={null}
        latest={{
          bodyweightKg: 70,
          edgeSizeMm: 20,
          exercise: "max_hang",
          externalLoadKg: 15,
          gripPosition: "half_crimp",
          holdDurationSeconds: 10,
          laterality: "both",
          notes: null,
          restIntervalSeconds: 180,
          rpe: 8,
          setCount: 5,
        }}
        loading={false}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Repeat previous finger session" }));
    expect(screen.getByLabelText("Edge size (mm)")).toHaveValue(20);
    fireEvent.click(screen.getByRole("button", { name: "Save finger session" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyweightKg: 70,
        edgeSizeMm: 20,
        exercise: "max_hang",
        externalLoadKg: 15,
        setCount: 5,
        startedAt: expect.any(String),
      }),
    );
  });

  it("shows the specific server error", () => {
    render(
      <FingerLoadingLog
        errorMessage="Bodyweight must be positive"
        latest={null}
        loading={false}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Bodyweight must be positive");
  });
});
