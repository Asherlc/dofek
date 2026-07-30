// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FingerLoadingLog } from "./FingerLoadingLog";

describe("mobile FingerLoadingLog", () => {
  it("repeats the previous protocol and submits raw metric values", () => {
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
        unitSystem="metric"
      />,
    );

    fireEvent.click(screen.getByLabelText("Repeat previous finger session"));
    fireEvent.click(screen.getByLabelText("Save finger session"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyweightKg: 70,
        edgeSizeMm: 20,
        externalLoadKg: 15,
        startedAt: expect.any(String),
      }),
    );
  });
});
