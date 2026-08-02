import { fireEvent, render, screen } from "@testing-library/react";
import type { CalendarDay } from "dofek-server/types";
import { describe, expect, it } from "vitest";
import { ActivityHeatmap } from "./ActivityHeatmap";

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

describe("ActivityHeatmap", () => {
  it("renders the shared measure, unit, and meaning on mobile", () => {
    render(<ActivityHeatmap data={data} />);

    expect(screen.getByText("Training time (minutes per day)")).toBeTruthy();
    expect(screen.getByText("61–120 min")).toBeTruthy();
    expect(screen.getByText("High training volume; compare with recovery.")).toBeTruthy();
  });

  it("makes exact day details available from an accessible day button", () => {
    render(<ActivityHeatmap data={data} />);

    const dayButton = screen.getByRole("button", { name: /72 minutes of training time/ });
    expect(dayButton.getAttribute("aria-description")).toContain("Double-tap");

    fireEvent.click(dayButton);
    expect(screen.getByText("72 minutes of training time")).toBeTruthy();
    expect(screen.getByText("High training volume; compare with recovery.")).toBeTruthy();
  });
});
