// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { cyclingPowerProfileFixture } from "../../../server/src/contracts/cycling-power-profile-test-fixture.ts";
import { CyclingPowerProfile } from "./CyclingPowerProfile.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ params, children }: { params: { id: string }; children: React.ReactNode }) => (
    <a href={`/activity/${params.id}`}>{children}</a>
  ),
}));

vi.mock("../pages/ProviderRecordDetail.tsx", () => ({
  ProviderRecordDetail: ({ input }: { input: { recordId: string; dataType: string } }) => (
    <div role="dialog">
      {input.dataType} {input.recordId}
    </div>
  ),
}));

it("shows the recorded effort and opens the supporting activity and weight records", () => {
  render(<CyclingPowerProfile profile={cyclingPowerProfileFixture} />);
  expect(screen.getByText("5 seconds")).toBeTruthy();
  expect(screen.getByText("1 minute")).toBeTruthy();
  expect(screen.getByText("4.67 W/kg")).toBeTruthy();
  expect(screen.getByText("288 W")).toBeTruthy();
  expect(screen.queryByText(/provisional|virtual|method is unknown|withings/i)).toBeNull();
  const details = screen.getByText("5 minutes").closest("summary");
  if (!details) throw new Error("Expected effort disclosure");
  fireEvent.click(details);
  expect(screen.getByRole("link", { name: "View activity" }).getAttribute("href")).toBe(
    "/activity/00000000-0000-4000-8000-000000000010",
  );
  const weightLink = screen.getAllByRole("button", { name: /Oct 31/ })[0];
  if (!weightLink) throw new Error("Expected weight record link");
  fireEvent.click(weightLink);
  expect(screen.getByRole("dialog").textContent).toContain(
    "bodyMeasurements 00000000-0000-4000-8000-000000000020",
  );
});
