/** @vitest-environment jsdom */

import {
  climbingBestOnsightFixture,
  emptyClimbingBestOnsightFixture,
} from "@dofek/training/fixtures/climbing-best-onsight";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ClimbingBestOnsight } from "./ClimbingBestOnsight.tsx";

vi.mock("../pages/ProviderRecordDetail.tsx", () => ({
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

// Exercise the whole matrix under a UTC+12+ offset so the date-only window
// bounds must stay on their authored calendar day (a New Zealand regression).
vi.stubEnv("TZ", "Pacific/Auckland");
afterAll(() => vi.unstubAllEnvs());

describe("ClimbingBestOnsight", () => {
  afterEach(cleanup);

  it("renders the authored date window, all five climbing types, and both settings from the annual result", () => {
    render(<ClimbingBestOnsight data={climbingBestOnsightFixture()} />);

    expect(screen.getByRole("heading", { name: "Best recorded onsight" })).toBeVisible();
    expect(screen.getByText("Past 12 months · Nov 22, 2025–Nov 21, 2026")).toBeVisible();
    const table = screen.getByRole("table", { name: "Best recorded onsight" });
    expect(table).toBeVisible();
    for (const column of ["Climbing type", "Gym", "Outdoor"]) {
      expect(within(table).getByRole("columnheader", { name: column })).toBeVisible();
    }
    for (const type of ["Bouldering", "Lead", "Top rope", "Follow", "Unroped"]) {
      expect(within(table).getByRole("rowheader", { name: type })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "V5, open Gym Bouldering send" })).toHaveTextContent(
      "V5",
    );
    expect(
      screen.getByRole("button", { name: "6B+, open Outdoor Bouldering send" }),
    ).toHaveTextContent("6B+");
    expect(screen.getByRole("button", { name: "5.11a, open Gym Lead send" })).toHaveTextContent(
      "5.11a",
    );
    expect(screen.getByRole("button", { name: "5.10c, open Outdoor Lead send" })).toHaveTextContent(
      "5.10c",
    );
    for (const setting of ["Gym", "Outdoor"]) {
      for (const type of ["Top rope", "Follow", "Unroped"]) {
        expect(screen.getByLabelText(`No recorded ${setting} ${type} onsight`)).toBeVisible();
      }
    }
  });

  it("opens the exact provider and record behind an accessible grade name and closes back to the matrix", () => {
    render(<ClimbingBestOnsight data={climbingBestOnsightFixture()} />);

    expect(screen.queryByRole("dialog", { name: "Climb detail" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "5.11a, open Gym Lead send" }));

    const dialog = screen.getByRole("dialog", { name: "Climb detail" });
    expect(within(dialog).getByTestId("record-detail-input")).toHaveTextContent(
      JSON.stringify({
        providerId: "kaya",
        dataType: "climbingLogEntries",
        recordId: "44444444-4444-4444-8444-000000000003",
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close detail" }));
    expect(screen.queryByRole("dialog", { name: "Climb detail" })).toBeNull();
    expect(screen.getByRole("button", { name: "5.11a, open Gym Lead send" })).toBeVisible();
  });

  it("keeps loaded grades visible during a background refresh and shows its error", () => {
    render(
      <ClimbingBestOnsight
        data={climbingBestOnsightFixture()}
        error={new Error("Reconnect the climbing provider")}
      />,
    );

    expect(screen.getByRole("button", { name: "V5, open Gym Bouldering send" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Reconnect the climbing provider");
  });

  it("shows a blocking loading state while the annual result is loading", () => {
    render(<ClimbingBestOnsight data={undefined} loading />);

    expect(screen.getByTestId("query-state-loading")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders no spinner when the annual result is absent and idle", () => {
    render(<ClimbingBestOnsight data={undefined} />);

    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an error without an empty substitute when the first load fails", () => {
    render(
      <ClimbingBestOnsight data={undefined} error={new Error("Annual onsights unavailable")} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Annual onsights unavailable");
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
  });

  it("renders the same dash-only matrix with accessible cell descriptions when all cells are empty", () => {
    render(<ClimbingBestOnsight data={emptyClimbingBestOnsightFixture()} />);

    expect(screen.getByRole("heading", { name: "Best recorded onsight" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Best recorded onsight" })).toBeVisible();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    for (const setting of ["Gym", "Outdoor"]) {
      for (const type of ["Bouldering", "Lead", "Top rope", "Follow", "Unroped"]) {
        expect(screen.getByLabelText(`No recorded ${setting} ${type} onsight`)).toHaveTextContent(
          "—",
        );
      }
    }
  });
});
