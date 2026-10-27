// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
import { ProviderRecordDetailModal } from "./provider-record-detail-modal";

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
it("renders a supported old-server scalar grip and numeric angle", () => {
  const { holdTypes: _holdTypes, ...entry } = climbingLogEntryFixture({
    wallAngle: { value: 30, unit: "degrees" },
  });
  render(
    <ProviderRecordDetailModal
      dataType="climbingLogEntries"
      state={{
        data: { ...entry, holdType: "crimp" },
        error: null,
        isLoading: false,
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Hold types: crimp")).toBeTruthy();
  expect(screen.getByText("Wall angle: 30°")).toBeTruthy();
});

it("preserves current-server categories and every recorded grip", () => {
  render(
    <ProviderRecordDetailModal
      dataType="climbingLogEntries"
      state={{
        data: climbingLogEntryFixture({
          holdTypes: ["crimp", "volume"],
          wallAngle: { category: "slab" },
        }),
        error: null,
        isLoading: false,
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Hold types: crimp, volume")).toBeTruthy();
  expect(screen.getByText("Wall angle: Slab")).toBeTruthy();
});

it("keeps cached climbing details visible beside a refresh error", () => {
  const climb = climbingClimbFixture();
  climb.coordinates = { latitude: 0, longitude: -120 };
  render(
    <ProviderRecordDetailModal
      dataType="climbingLogEntries"
      state={{
        data: climbingLogEntryFixture({ climb, climbId: climb.id }),
        error: new Error("Detail refresh failed"),
        isLoading: false,
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Detail refresh failed")).toBeTruthy();
  expect(screen.getByText("Corner")).toBeTruthy();
  expect(screen.getByText("Grades")).toBeTruthy();
});
it("keeps closing available while a detail is loading or unavailable", () => {
  const onClose = vi.fn();
  const view = render(
    <ProviderRecordDetailModal
      dataType="climbingLogEntries"
      state={{ data: undefined, error: null, isLoading: true }}
      onClose={onClose}
    />,
  );
  expect(screen.getByText("Loading record...")).toBeTruthy();
  view.rerender(
    <ProviderRecordDetailModal
      dataType="climbingLogEntries"
      state={{ data: null, error: null, isLoading: false }}
      onClose={onClose}
    />,
  );
  expect(
    screen.getByText("This record is no longer available. Refresh the records list."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close record detail" }));
  expect(onClose).toHaveBeenCalledOnce();
});
