import type { HangboardingDetail as HangboardingDetailData } from "@dofek/providers/hangboarding";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HangboardingDetail } from "./HangboardingDetail";

const detail: HangboardingDetailData = {
  planName: "7/3 Repeaters",
  sessionId: "session-1",
  boardId: "board-1",
  boardName: "Tension Board",
  segmentsError: null,
  intervals: [
    {
      id: "interval-1",
      intervalIndex: 0,
      label: "Step 1: 19 mm edge",
      intervalType: "work",
      startedAt: "2026-08-07T14:00:00.000Z",
      endedAt: "2026-08-07T14:00:07.000Z",
      durationSeconds: 7,
    },
    {
      id: "interval-2",
      intervalIndex: 1,
      label: "Rest",
      intervalType: "rest",
      startedAt: "2026-08-07T14:00:07.000Z",
      endedAt: "2026-08-07T14:00:53.000Z",
      durationSeconds: 46,
    },
  ],
};

describe("HangboardingDetail", () => {
  it("renders plan and board metadata plus interval labels, types, timestamps, and durations", () => {
    render(<HangboardingDetail data={detail} loading={false} error={null} />);

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("7/3 Repeaters")).toBeTruthy();
    expect(screen.getByText("Session")).toBeTruthy();
    expect(screen.getByText("session-1")).toBeTruthy();
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Tension Board")).toBeTruthy();
    expect(screen.getByText("Board ID")).toBeTruthy();
    expect(screen.getByText("board-1")).toBeTruthy();
    expect(
      screen.getAllByTestId("hangboarding-interval-label").map((node) => node.textContent),
    ).toEqual(["Step 1: 19 mm edge", "Rest"]);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getAllByText("Rest")).toHaveLength(2);
    expect(screen.getAllByText(/2026/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("7s")).toBeTruthy();
    expect(screen.getByText("46s")).toBeTruthy();
  });

  it("renders empty metadata and nullable interval fields as em dashes", () => {
    render(
      <HangboardingDetail
        data={{
          ...detail,
          planName: null,
          sessionId: null,
          boardId: null,
          boardName: null,
          intervals: [
            {
              ...detail.intervals[0],
              label: null,
              intervalType: null,
              endedAt: null,
              durationSeconds: null,
            },
          ],
        }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(8);
  });

  it("preserves valid intervals while showing an actionable import warning", () => {
    render(
      <HangboardingDetail
        data={{ ...detail, segmentsError: "Segment 3 had no end timestamp" }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("Segment 3 had no end timestamp");
    expect(screen.getByText("Step 1: 19 mm edge")).toBeTruthy();
  });

  it("uses explicit loading and preserves the server error message", () => {
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
    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(screen.getByText("Hangboarding details unavailable")).toBeTruthy();
  });
});
