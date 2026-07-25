/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProcessingStatusSnapshot,
  ProcessingStatusWidget,
} from "./ProcessingStatusWidget.tsx";

const snapshot: ProcessingStatusSnapshot = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  scope: { providerId: "garmin", datasets: ["activity"] },
  overallStatus: "active",
  datasets: [
    {
      key: "activity",
      label: "Activities",
      status: "active",
      currentStage: "analytics",
      progressPercentage: 60,
      lastAdvancedAt: "2026-07-22T11:59:00.000Z",
      lastReadyAt: "2026-07-21T12:00:00.000Z",
    },
  ],
  operations: [
    {
      id: "00000000-0000-4000-8000-000000001852",
      providerId: "garmin",
      kind: "provider_sync",
      createdAt: "2026-07-22T11:58:00.000Z",
      status: "active",
      datasets: ["activity"],
      timeline: [
        {
          sequence: 1,
          stage: "ingest",
          status: "succeeded",
          datasetKey: "activity",
          outputPath: null,
          occurredAt: "2026-07-22T11:58:30.000Z",
          progressPercentage: 100,
          message: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
    },
  ],
};
const activityDataset = snapshot.datasets.at(0);
if (!activityDataset) throw new Error("Expected the processing snapshot fixture to include data");

describe("ProcessingStatusWidget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays quiet when ready unless always visible", () => {
    const ready: ProcessingStatusSnapshot = { ...snapshot, overallStatus: "ready" };
    expect(render(<ProcessingStatusWidget data={ready} />).container.innerHTML).toBe("");
    render(<ProcessingStatusWidget data={ready} alwaysVisible />);
    expect(screen.getByText("Garmin sync complete")).toBeTruthy();
  });

  it("shows progress without exposing internal processing stages", () => {
    render(<ProcessingStatusWidget data={snapshot} contextLabel="Garmin" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
    expect(screen.getByText("Syncing Garmin").closest("section")).not.toBeNull();
    expect(
      screen.queryByText("Your existing data stays available while this update finishes."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show processing details" })).toBeNull();
    expect(screen.queryByText("Receiving data")).toBeNull();
  });

  it("names the affected area when processing is not provider-scoped", () => {
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          scope: { providerId: null, datasets: ["sleep"] },
          datasets: [{ ...activityDataset, key: "sleep", label: "Sleep" }],
        }}
      />,
    );

    const progress = screen.getByRole("progressbar", { name: "Recomputing sleep" });
    expect(progress.getAttribute("aria-valuenow")).toBe("60");
    expect(screen.queryByRole("heading", { name: "Recomputing sleep" })).toBeNull();
    expect(screen.getByText("Recomputing sleep", { selector: "span" })).toBeTruthy();
  });

  it("surfaces the server error message", () => {
    render(<ProcessingStatusWidget error={new Error("Reconnect Kaya and try again.")} />);
    expect(screen.getByText("Reconnect Kaya and try again.")).toBeTruthy();
    expect(screen.getByText("Processing status is unavailable").closest("section")).not.toBeNull();
  });

  it("preserves cached status when a background refetch fails", () => {
    render(
      <ProcessingStatusWidget
        data={snapshot}
        error={new Error("The processing status refresh failed.")}
      />,
    );

    expect(screen.getByText("Syncing Garmin")).toBeTruthy();
    expect(screen.queryByText("Processing status is unavailable")).toBeNull();
  });

  it("renders an accessible loading state when no snapshot is available", () => {
    render(<ProcessingStatusWidget loading alwaysVisible />);

    expect(screen.getByText("Loading processing status…")).toBeTruthy();
    expect(
      screen.getByText("Loading processing status…").closest("section")?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("hides aggregate progress when a non-ready dataset has no progress", () => {
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          datasets: [
            ...snapshot.datasets,
            {
              ...activityDataset,
              key: "sleep",
              label: "Sleep",
              status: "waiting",
              progressPercentage: null,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
