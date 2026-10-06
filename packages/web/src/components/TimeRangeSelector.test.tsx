// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimeRangeSelector } from "./TimeRangeSelector.tsx";

describe("TimeRangeSelector", () => {
  it("exposes the selected range as a checked radio option", () => {
    render(<TimeRangeSelector days={90} onChange={vi.fn()} />);

    expect(screen.getByRole("radio", { name: "90d" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "30d" })).not.toBeChecked();
  });
});
