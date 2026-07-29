import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProcessingStatusSnapshot, ProcessingStatusWidget } from "./ProcessingStatusWidget";

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
      lastReadyAt: null,
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
const operation = snapshot.operations.at(0);
if (!operation) throw new Error("Expected the processing snapshot fixture to include an operation");
const timelineEvent = operation.timeline.at(0);
if (!timelineEvent) throw new Error("Expected the processing snapshot fixture to include an event");

describe("ProcessingStatusWidget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays quiet when ready unless always visible", () => {
    const ready: ProcessingStatusSnapshot = { ...snapshot, overallStatus: "ready" };
    expect(render(<ProcessingStatusWidget data={ready} />).container.innerHTML).toBe("");
    render(<ProcessingStatusWidget data={ready} alwaysVisible />);
    expect(screen.getByText("Garmin sync complete")).toBeTruthy();
  });

  it("shows progress without exposing internal processing stages", () => {
    render(<ProcessingStatusWidget data={snapshot} />);
    expect(
      screen.getByTestId("processing-status-progress").getAttribute("accessibilityValue"),
    ).not.toBeNull();
    expect(screen.getByText("Syncing Garmin")).toBeTruthy();
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
    expect(progress.getAttribute("accessibilityValue")).not.toBeNull();
    expect(screen.getByText("Recomputing sleep")).toBeTruthy();
  });

  it("surfaces the server error message", () => {
    render(<ProcessingStatusWidget error={new Error("Reconnect Kaya and try again.")} />);
    expect(screen.getByText("Reconnect Kaya and try again.")).toBeTruthy();
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

    expect(screen.queryByTestId("processing-status-progress")).toBeNull();
  });

  it.each([
    "failed",
    "blocked",
  ] as const)("surfaces %s datasets, their last ready age, and the actionable error", (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T14:00:00.000Z"));
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          overallStatus: status,
          datasets: [
            {
              ...activityDataset,
              status,
              progressPercentage: null,
              lastReadyAt: "2026-07-22T12:00:00.000Z",
            },
          ],
          operations: [
            {
              ...operation,
              status,
              timeline: [
                {
                  ...timelineEvent,
                  status: "failed",
                  errorMessage: "Reconnect Garmin, then start the sync again.",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Garmin sync didn’t finish")).toBeTruthy();
    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText(status === "failed" ? "Failed" : "Blocked")).toBeTruthy();
    expect(screen.getByText("Last ready: 2h ago")).toBeTruthy();
    expect(screen.getByText("Reconnect Garmin, then start the sync again.")).toBeTruthy();
  });

  it("shows every dataset and its freshness when explicitly kept visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T14:00:00.000Z"));
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          overallStatus: "ready",
          datasets: [
            {
              ...activityDataset,
              status: "ready",
              progressPercentage: 100,
              lastReadyAt: "2026-07-22T12:00:00.000Z",
            },
          ],
        }}
        alwaysVisible
      />,
    );

    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Last ready: 2h ago")).toBeTruthy();
  });

  it("does not show a resolved failure beneath a ready dataset", () => {
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          overallStatus: "ready",
          datasets: [
            {
              ...activityDataset,
              status: "ready",
              progressPercentage: 100,
            },
          ],
          operations: [
            {
              ...operation,
              status: "ready",
              timeline: [
                {
                  ...timelineEvent,
                  status: "failed",
                  errorMessage: "Resolved activity failure",
                },
              ],
            },
          ],
        }}
        alwaysVisible
      />,
    );

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText("Resolved activity failure")).toBeNull();
  });

  it("surfaces a failed dataset on downstream metric screens", () => {
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          scope: { providerId: null, datasets: ["activity"] },
          overallStatus: "failed",
          datasets: [
            {
              ...activityDataset,
              status: "failed",
              progressPercentage: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("does not claim freshness for synthetic ready datasets without processing history", () => {
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          overallStatus: "ready",
          operations: [],
          datasets: [
            {
              ...activityDataset,
              status: "ready",
              progressPercentage: null,
              lastAdvancedAt: null,
              lastReadyAt: null,
            },
          ],
        }}
        alwaysVisible
      />,
    );

    expect(screen.getByText("Garmin sync complete")).toBeTruthy();
    expect(screen.queryByText("Activities")).toBeNull();
    expect(screen.queryByText("No completed update recorded")).toBeNull();
  });
});
