import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HangboardingDetail } from "./HangboardingDetail";

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

describe("HangboardingDetail", () => {
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

  it("renders empty metadata and nullable interval fields as em dashes", () => {
    render(
      <HangboardingDetail
        data={{
          ...detail,
          planName: null,
          boardName: null,
          summary: {
            ...detail.summary,
            durationSeconds: null,
            totalWorkDurationSeconds: null,
            totalRestDurationSeconds: null,
          },
        }}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
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
    expect(screen.getByText("19 mm edge")).toBeTruthy();
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
