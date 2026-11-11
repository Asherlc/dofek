/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HangboardingDetail } from "./HangboardingDetail.tsx";

const detail = {
  planName: "7/3 Repeaters",
  boardName: "Tension Board",
  segmentsError: null,
  summary: {
    durationSeconds: 300,
    workIntervalCount: 3,
    totalWorkDurationSeconds: 21,
    totalRestDurationSeconds: 106,
    exercises: [{ label: "19 mm edge", workIntervalCount: 3, workDurationSeconds: 21 }],
  },
};

afterEach(cleanup);

describe("HangboardingDetail", () => {
  it("shows only session metrics when the sole exercise is generic Work", () => {
    render(
      <HangboardingDetail
        data={{
          ...detail,
          summary: {
            ...detail.summary,
            exercises: [{ label: "Work", workIntervalCount: 3, workDurationSeconds: 21 }],
          },
        }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText("Hangs")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("21s")).toBeTruthy();
    expect(screen.getByText("Session time")).toBeTruthy();
    expect(screen.queryByText("Work")).toBeNull();
    expect(screen.queryByText("3 hangs · 21s")).toBeNull();
    expect(screen.queryByText("No completed hangs recorded.")).toBeNull();
  });

  it("keeps generic work in a breakdown alongside named exercises", () => {
    render(
      <HangboardingDetail
        data={{
          ...detail,
          summary: {
            ...detail.summary,
            exercises: [
              { label: "Work", workIntervalCount: 1, workDurationSeconds: 7 },
              { label: "19 mm edge", workIntervalCount: 2, workDurationSeconds: 14 },
            ],
          },
        }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("1 hang · 7s")).toBeTruthy();
    expect(screen.getByText("19 mm edge")).toBeTruthy();
    expect(screen.getByText("2 hangs · 14s")).toBeTruthy();
  });

  it("renders a concise finger-loading summary", () => {
    render(<HangboardingDetail data={detail} loading={false} error={null} />);

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("7/3 Repeaters")).toBeTruthy();
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Tension Board")).toBeTruthy();
    expect(screen.getByText("19 mm edge")).toBeTruthy();
    expect(screen.getByText("3 hangs · 21s")).toBeTruthy();
    expect(screen.getByText("Hangs")).toBeTruthy();
    expect(screen.getByText("Hang time")).toBeTruthy();
    expect(screen.getByText("Rest time")).toBeTruthy();
    expect(screen.getByText("Session time")).toBeTruthy();
  });

  it("renders an empty state when there are no completed hangs", () => {
    render(
      <HangboardingDetail
        data={{
          ...detail,
          summary: { ...detail.summary, exercises: [] },
        }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText("No completed hangs recorded.")).toBeTruthy();
  });

  it("renders an actionable segments note without hiding valid data", () => {
    render(
      <HangboardingDetail
        data={{ ...detail, segmentsError: "Segment 3 had no end timestamp" }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Segment 3 had no end timestamp");
    expect(screen.getByText("7/3 Repeaters")).toBeTruthy();
    expect(screen.getByText("19 mm edge")).toBeTruthy();
  });

  it("uses the query-state loading and error conventions", () => {
    const { rerender } = render(
      <HangboardingDetail data={undefined} loading={true} error={null} />,
    );
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();

    rerender(
      <HangboardingDetail
        data={undefined}
        loading={false}
        error={new Error("Hangboarding details unavailable")}
      />,
    );
    expect(screen.getByText("Hangboarding details unavailable")).toBeTruthy();
    expect(screen.getByTestId("query-state-error")).toBeTruthy();
  });
});
