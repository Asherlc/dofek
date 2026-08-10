/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HangboardingDetail as HangboardingDetailData } from "../../../server/src/repositories/hangboarding-repository.ts";

import { HangboardingDetail } from "./HangboardingDetail.tsx";

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

afterEach(cleanup);

describe("HangboardingDetail", () => {
  it("renders plan and board metadata plus intervals in index order", () => {
    render(<HangboardingDetail data={detail} loading={false} error={null} />);

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("7/3 Repeaters")).toBeTruthy();
    expect(screen.getByText("Session")).toBeTruthy();
    expect(screen.getByText("session-1")).toBeTruthy();
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Tension Board")).toBeTruthy();

    const labels = screen.getAllByTestId("hangboarding-interval-label");
    expect(labels.map((label) => label.textContent)).toEqual(["Step 1: 19 mm edge", "Rest"]);
    expect(screen.getByText("7s")).toBeTruthy();
    expect(screen.getByText("46s")).toBeTruthy();
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
    expect(screen.getByText("Step 1: 19 mm edge")).toBeTruthy();
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
