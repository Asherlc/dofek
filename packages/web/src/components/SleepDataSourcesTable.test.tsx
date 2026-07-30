/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type SleepDataSourceRow, SleepDataSourcesTable } from "./SleepDataSourcesTable.tsx";

function row(day: number): SleepDataSourceRow {
  return {
    date: `2026-03-${String(day).padStart(2, "0")}`,
    durationMinutes: 480,
    providerId: "whoop",
    sourceName: `Source ${day}`,
    sourceProviders: [],
    stagingAvailable: true,
  };
}

describe("SleepDataSourcesTable", () => {
  it("paginates sleep nights newest first", () => {
    render(
      <SleepDataSourcesTable rows={Array.from({ length: 21 }, (_, index) => row(index + 1))} />,
    );

    expect(screen.getByText(/Source 21/)).toBeDefined();
    expect(screen.queryByText(/Source 1$/)).toBeNull();
    expect(screen.getByText("1 / 2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next nights page" }));

    expect(screen.getByText(/Source 1$/)).toBeDefined();
    expect(screen.queryByText(/Source 21/)).toBeNull();
    expect(screen.getByText("2 / 2")).toBeDefined();
  });

  it("labels nights without a stage breakdown as partial", () => {
    render(<SleepDataSourcesTable rows={[{ ...row(1), stagingAvailable: false }]} />);

    expect(screen.getByText("Partial")).toBeDefined();
  });
});
