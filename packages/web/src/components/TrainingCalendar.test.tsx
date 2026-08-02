/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { CalendarDay } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    onEvents,
    option,
  }: {
    onEvents?: Record<string, (params: Record<string, unknown>) => void>;
    option: Record<string, unknown>;
  }) => (
    <div data-testid="training-calendar-chart" data-option={JSON.stringify(option)}>
      <button type="button" onClick={() => onEvents?.click?.({ value: ["2026-03-18", 72] })}>
        Choose chart day
      </button>
    </div>
  ),
}));

const { TrainingCalendar } = await import("./TrainingCalendar.tsx");

const data: CalendarDay[] = [
  {
    date: "2026-03-10",
    activityCount: 1,
    totalMinutes: 0,
    activityTypes: [],
    trainingTimeBand: "none",
    trainingTimeMeaning: "No recorded training; this may be a recovery/rest day.",
  },
  {
    date: "2026-03-18",
    activityCount: 1,
    totalMinutes: 72,
    activityTypes: ["running"],
    trainingTimeBand: "high",
    trainingTimeMeaning: "High training volume; compare with recovery.",
  },
];

describe("TrainingCalendar", () => {
  it("labels the measure and exposes semantic legend details", () => {
    render(<TrainingCalendar data={data} />);

    expect(screen.getByText("Training time (minutes per day)")).toBeTruthy();
    expect(screen.getByText("0 min")).toBeTruthy();
    expect(screen.getByText("61–120 min")).toBeTruthy();
    expect(
      screen.getAllByText(/High training volume; compare with recovery/).length,
    ).toBeGreaterThan(0);

    const chartOption =
      screen.getByTestId("training-calendar-chart").getAttribute("data-option") ?? "";
    expect(chartOption).toContain('"name":"Training time (minutes per day)"');
    expect(chartOption).toContain('"label":"0 min"');
    expect(chartOption).toContain('"label":">120 min"');
  });

  it("exposes exact day details through a keyboard/tap-selectable control and chart click", () => {
    render(<TrainingCalendar data={data} />);

    const selector = screen.getByRole("combobox", { name: "View daily training details" });
    expect(selector).toHaveValue("2026-03-18");
    expect(screen.getByText(/72 minutes of training time/)).toBeTruthy();

    fireEvent.change(selector, { target: { value: "2026-03-10" } });
    expect(screen.getByText(/0 minutes of training time/)).toBeTruthy();
    expect(
      screen.getAllByText(/No recorded training; this may be a recovery\/rest day/).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Choose chart day" }));
    expect(screen.getByText(/72 minutes of training time/)).toBeTruthy();
  });
});
