// @vitest-environment jsdom

import {
  climbingBestOnsightFixture,
  emptyClimbingBestOnsightFixture,
} from "@dofek/training/fixtures/climbing-best-onsight";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimbingBestOnsight } from "./ClimbingBestOnsight";

vi.mock("./providers/provider-record-detail", () => ({
  ProviderRecordDetail: ({
    input,
    onClose,
  }: {
    input: { providerId: string; dataType: string; recordId: string };
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Climb detail">
      <span data-testid="record-detail-input">{JSON.stringify(input)}</span>
      <button type="button" onClick={onClose}>
        Close detail
      </button>
    </div>
  ),
}));

describe("ClimbingBestOnsight", () => {
  afterEach(cleanup);

  it("renders all five climbing types and both settings from the annual result", () => {
    render(<ClimbingBestOnsight data={climbingBestOnsightFixture()} />);

    expect(screen.getByText("Best recorded onsight")).toBeTruthy();
    expect(screen.getByText("Past 12 months · Nov 22, 2025–Nov 21, 2026")).toBeTruthy();
    for (const type of ["Bouldering", "Lead", "Top rope", "Follow", "Unroped"]) {
      expect(screen.getByText(type)).toBeTruthy();
    }
    for (const [grade, name] of [
      ["V5", "V5, open Gym Bouldering send"],
      ["6B+", "6B+, open Outdoor Bouldering send"],
      ["5.11a", "5.11a, open Gym Lead send"],
      ["5.10c", "5.10c, open Outdoor Lead send"],
    ]) {
      expect(screen.getByText(grade)).toBeTruthy();
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    for (const setting of ["Gym", "Outdoor"]) {
      for (const type of ["Top rope", "Follow", "Unroped"]) {
        expect(screen.getByLabelText(`No recorded ${setting} ${type} onsight`)).toBeTruthy();
      }
    }
  });

  it("opens the exact provider and record behind an accessible grade name and closes back to the matrix", () => {
    render(<ClimbingBestOnsight data={climbingBestOnsightFixture()} />);

    expect(screen.queryByRole("dialog", { name: "Climb detail" })).toBeNull();
    fireEvent.click(screen.getByLabelText("5.11a, open Gym Lead send"));

    const dialog = screen.getByRole("dialog", { name: "Climb detail" });
    expect(within(dialog).getByTestId("record-detail-input").textContent).toBe(
      JSON.stringify({
        providerId: "kaya",
        dataType: "climbingLogEntries",
        recordId: "44444444-4444-4444-8444-000000000003",
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close detail" }));
    expect(screen.queryByRole("dialog", { name: "Climb detail" })).toBeNull();
    expect(screen.getByLabelText("5.11a, open Gym Lead send")).toBeTruthy();
  });

  it("keeps loaded grades visible during a background refresh and shows its error", () => {
    render(
      <ClimbingBestOnsight
        data={climbingBestOnsightFixture()}
        error={new Error("Reconnect the climbing provider")}
      />,
    );

    expect(screen.getByLabelText("V5, open Gym Bouldering send")).toBeTruthy();
    expect(screen.getByText("Reconnect the climbing provider")).toBeTruthy();
  });

  it("shows a blocking loading state while the annual result is loading", () => {
    render(<ClimbingBestOnsight data={undefined} loading />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Bouldering")).toBeNull();
  });

  it("renders no spinner when the annual result is absent and idle", () => {
    render(<ClimbingBestOnsight data={undefined} />);

    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(screen.queryByText("Bouldering")).toBeNull();
  });

  it("shows an error without an empty substitute when the first load fails", () => {
    render(
      <ClimbingBestOnsight data={undefined} error={new Error("Annual onsights unavailable")} />,
    );

    expect(screen.getByText("Annual onsights unavailable")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
  });

  it("renders the same dash-only matrix with accessible cell descriptions when all cells are empty", () => {
    render(<ClimbingBestOnsight data={emptyClimbingBestOnsightFixture()} />);

    expect(screen.getByText("Best recorded onsight")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
    expect(screen.queryByLabelText("V5, open Gym Bouldering send")).toBeNull();
    for (const setting of ["Gym", "Outdoor"]) {
      for (const type of ["Bouldering", "Lead", "Top rope", "Follow", "Unroped"]) {
        expect(screen.getByLabelText(`No recorded ${setting} ${type} onsight`)).toBeTruthy();
      }
    }
  });
});
