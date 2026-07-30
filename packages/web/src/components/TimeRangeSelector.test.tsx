// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimeRangeSelector } from "./TimeRangeSelector.tsx";

describe("TimeRangeSelector", () => {
  it("visibly explains why the selected domain uses its default period", () => {
    render(
      <TimeRangeSelector
        days={90}
        description="Default: 90 days balances recent training changes with enough history."
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Default: 90 days balances recent training changes with enough history."),
    ).toBeTruthy();
  });
});
