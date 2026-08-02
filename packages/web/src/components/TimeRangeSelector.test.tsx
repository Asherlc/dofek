// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimeRangeSelector } from "./TimeRangeSelector.tsx";

describe("TimeRangeSelector", () => {
  it("visibly explains why the selected domain uses its default period", () => {
    render(
      <TimeRangeSelector
        days={90}
        description="Recommended default: 90 days balances recent training changes with enough history."
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Recommended default: 90 days balances recent training changes with enough history.",
      ),
    ).toBeTruthy();
  });

  it("exposes the selected range as a checked radio option", () => {
    render(
      <TimeRangeSelector days={90} description="Recent training changes." onChange={vi.fn()} />,
    );

    expect(screen.getByRole("radio", { name: "90d" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "30d" })).not.toBeChecked();
  });
});
