/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProcessingStatusSnapshot,
  ProcessingStatusWidget,
} from "./ProcessingStatusWidget.tsx";

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
      lastReadyAt: "2026-07-21T12:00:00.000Z",
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
    expect(screen.getByText("Data is ready")).toBeTruthy();
  });

  it("shows progress and an accessible expanded timeline", () => {
    render(<ProcessingStatusWidget data={snapshot} contextLabel="Kaya" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
    expect(screen.getByText("Updating your data").closest("section")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show processing details" }));
    expect(screen.getByText("Receiving data")).toBeTruthy();
    expect(screen.getByText(/Completed/)).toBeTruthy();
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

    expect(screen.getByText("Updating your data")).toBeTruthy();
    expect(screen.queryByText("Processing status is unavailable")).toBeNull();
  });

  it("renders an accessible loading state when no snapshot is available", () => {
    render(<ProcessingStatusWidget loading alwaysVisible />);

    expect(screen.getByText("Loading processing status…")).toBeTruthy();
    expect(
      screen.getByText("Loading processing status…").closest("section")?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("shows the most recent failure message", () => {
    const operation = snapshot.operations.at(0);
    const timelineEvent = operation?.timeline.at(0);
    if (!operation || !timelineEvent) {
      throw new Error("Expected the processing snapshot fixture to include a timeline event");
    }
    const failed: ProcessingStatusSnapshot = {
      ...snapshot,
      overallStatus: "failed",
      operations: [
        {
          ...operation,
          status: "failed",
          timeline: [
            {
              ...timelineEvent,
              status: "failed",
              occurredAt: "2026-07-22T11:58:30.000Z",
              errorMessage: "The earlier attempt failed.",
            },
            {
              ...timelineEvent,
              status: "failed",
              occurredAt: "2026-07-22T11:59:30.000Z",
              errorMessage: "Reconnect Kaya and try again.",
            },
          ],
        },
      ],
    };

    render(<ProcessingStatusWidget data={failed} />);

    expect(screen.getByText("Reconnect Kaya and try again.")).toBeTruthy();
    expect(screen.queryByText("The earlier attempt failed.")).toBeNull();
  });

  it("uses failures only from the latest operation for each dataset", () => {
    const currentOperation = snapshot.operations.at(0);
    const timelineEvent = currentOperation?.timeline.at(0);
    if (!currentOperation || !timelineEvent) {
      throw new Error("Expected the processing snapshot fixture to include a timeline event");
    }
    const failed: ProcessingStatusSnapshot = {
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
    };

    render(<ProcessingStatusWidget data={failed} />);

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

    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders same-millisecond timeline events with unique keys", () => {
    const operation = snapshot.operations.at(0);
    const timelineEvent = operation?.timeline.at(0);
    if (!operation || !timelineEvent) {
      throw new Error("Expected the processing snapshot fixture to include a timeline event");
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ProcessingStatusWidget
        data={{
          ...snapshot,
          operations: [
            {
              ...operation,
              timeline: [timelineEvent, { ...timelineEvent, sequence: timelineEvent.sequence + 1 }],
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show processing details" }));

    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });
});
