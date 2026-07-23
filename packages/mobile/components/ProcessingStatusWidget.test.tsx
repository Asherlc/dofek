import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ProcessingStatusSnapshot, ProcessingStatusWidget } from "./ProcessingStatusWidget";

const snapshot: ProcessingStatusSnapshot = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  scope: { providerId: "kaya", datasets: ["activity"] },
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
      providerId: "kaya",
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

describe("ProcessingStatusWidget", () => {
  it("stays quiet when ready unless always visible", () => {
    const ready = { ...snapshot, overallStatus: "ready" as const };
    expect(render(<ProcessingStatusWidget data={ready} />).container.innerHTML).toBe("");
    render(<ProcessingStatusWidget data={ready} alwaysVisible />);
    expect(screen.getByText("Data is ready")).toBeTruthy();
  });

  it("shows equivalent progress and timeline behavior", () => {
    render(<ProcessingStatusWidget data={snapshot} />);
    expect(
      screen.getByTestId("processing-status-progress").getAttribute("accessibilityValue"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show processing details" }));
    expect(screen.getByText("Receiving data")).toBeTruthy();
    expect(screen.getByText(/Completed/)).toBeTruthy();
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

    expect(screen.getByText("Updating your data")).toBeTruthy();
    expect(screen.queryByText("Processing status is unavailable")).toBeNull();
  });

  it("uses failures only from the latest operation for each dataset", () => {
    const currentOperation = snapshot.operations.at(0);
    const timelineEvent = currentOperation?.timeline.at(0);
    if (!currentOperation || !timelineEvent) {
      throw new Error("Expected the processing snapshot fixture to include a timeline event");
    }
    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          overallStatus: "failed",
          datasets: [
            ...snapshot.datasets,
            {
              ...activityDataset,
              key: "sleep",
              label: "Sleep",
              status: "failed",
              progressPercentage: null,
            },
          ],
          operations: [
            {
              ...currentOperation,
              id: "00000000-0000-4000-8000-000000001853",
              createdAt: "2026-07-22T11:59:00.000Z",
              status: "active",
              timeline: [timelineEvent],
            },
            {
              ...currentOperation,
              createdAt: "2026-07-22T11:58:30.000Z",
              status: "failed",
              timeline: [
                {
                  ...timelineEvent,
                  status: "failed",
                  errorMessage: "The historical activity update failed.",
                },
              ],
            },
            {
              ...currentOperation,
              id: "00000000-0000-4000-8000-000000001854",
              createdAt: "2026-07-21T11:58:00.000Z",
              status: "failed",
              datasets: ["sleep"],
              timeline: [
                {
                  ...timelineEvent,
                  status: "failed",
                  datasetKey: "sleep",
                  errorMessage: "The current sleep update failed.",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("The current sleep update failed.")).toBeTruthy();
    expect(screen.queryByText("The historical activity update failed.")).toBeNull();
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
});
