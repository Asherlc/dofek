/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState.tsx";

describe("TrainingChartEmptyState", () => {
  it("renders server-authored requirements without reserving chart height", () => {
    const { container } = render(
      <TrainingChartEmptyState
        availability={{
          status: "insufficient_data",
          sourceLabel: "Running activity sensor summaries",
          observedCount: 0,
          minimumCount: 1,
          message:
            "No running pace data is available from Running activity sensor summaries. Record at least 1 running activity with pace data to show this chart.",
        }}
      />,
    );

    expect(screen.getByText(/No running pace data is available/)).toBeTruthy();
    expect(
      screen.getByText("0 of 1 required observations · Running activity sensor summaries"),
    ).toBeTruthy();
    expect(container.querySelector("[style*='height']")).toBeNull();
  });
});
