// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WeeklyVolumeBars } from "./WeeklyVolumeBars";

afterEach(cleanup);
it("labels recorded zero separately from unknown volume", () => {
  render(
    <WeeklyVolumeBars
      unit="km"
      weeks={[
        { week: "2026-10-12", value: 0 },
        { week: "2026-10-19", value: null },
      ]}
    />,
  );
  expect(screen.getByLabelText("2026-10-12: 0 km")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-19: Not recorded")).toBeTruthy();
});

it("formats duration values as hours and whole minutes", () => {
  render(
    <WeeklyVolumeBars
      unit="h:mm"
      weeks={[
        { week: "2026-10-05", value: 0 },
        { week: "2026-10-12", value: 85.8666666666666 },
        { week: "2026-10-19", value: 59.9 },
      ]}
    />,
  );
  expect(screen.getByText("0:00")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-05: 0:00 h:mm")).toBeTruthy();
  expect(screen.getByText("1:26")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-12: 1:26 h:mm")).toBeTruthy();
  expect(screen.getByText("1:00")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-19: 1:00 h:mm")).toBeTruthy();
});

it("rounds numeric volume values in visible and accessible labels", () => {
  render(<WeeklyVolumeBars unit="km" weeks={[{ week: "2026-10-19", value: 12.6 }]} />);
  expect(screen.getByText("13")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-19: 13 km")).toBeTruthy();
});
