// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { cyclingPowerProfileFixture } from "../../server/src/contracts/cycling-power-profile-test-fixture";
import { CyclingPowerProfile } from "./CyclingPowerProfile";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./providers/provider-record-detail", () => ({
  ProviderRecordDetail: ({ input }: { input: { recordId: string; dataType: string } }) => (
    <div role="dialog">
      {input.dataType} {input.recordId}
    </div>
  ),
}));

it("opens activity and weight records from the disclosed Cycling effort", () => {
  render(
    <CyclingPowerProfile
      profile={cyclingPowerProfileFixture}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("4.67 W/kg")).toBeTruthy();
  expect(screen.queryByText(/provisional|virtual|method is unknown|withings/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /5 minutes/ }));
  fireEvent.click(screen.getByRole("link", { name: "View activity" }));
  expect(mocks.push).toHaveBeenCalledWith({
    pathname: "/activity/[id]",
    params: { id: "00000000-0000-4000-8000-000000000010" },
  });
  fireEvent.click(screen.getByRole("link", { name: /Oct 31/ }));
  expect(screen.getByRole("dialog").textContent).toContain(
    "bodyMeasurements 00000000-0000-4000-8000-000000000020",
  );
});
