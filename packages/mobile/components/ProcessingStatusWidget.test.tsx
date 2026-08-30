import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProcessingStatusSnapshot, ProcessingStatusWidget } from "./ProcessingStatusWidget";

const {
  mockDismissOperation,
  mockDismissState,
  mockInvalidateAlerts,
  mockInvalidateStatus,
  mockPush,
} = vi.hoisted(() => {
  const mockDismissState: { error: Error | null; isPending: boolean } = {
    error: null,
    isPending: false,
  };
  return {
    mockDismissOperation: vi.fn(),
    mockDismissState,
    mockInvalidateAlerts: vi.fn(),
    mockInvalidateStatus: vi.fn(),
    mockPush: vi.fn(),
  };
});

vi.mock("../lib/trpc", () => ({
  trpc: {
    processing: {
      dismiss: {
        useMutation: (options: { onSuccess?: () => Promise<void> | void }) => ({
          error: mockDismissState.error,
          isPending: mockDismissState.isPending,
          mutate: (input: { operationId: string }) => {
            mockDismissOperation(input);
            if (!mockDismissState.error) {
              void options.onSuccess?.();
            }
          },
        }),
      },
    },
    useUtils: () => ({
      processing: {
        status: {
          invalidate: mockInvalidateStatus,
        },
        alerts: {
          invalidate: mockInvalidateAlerts,
        },
      },
    }),
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

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
      lastFailedAt: null,
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
      dismissed: false,
      errorMessage: null,
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
const operation = snapshot.operations.at(0);
if (!operation) throw new Error("Expected the processing snapshot fixture to include an operation");
const timelineEvent = operation.timeline.at(0);
if (!timelineEvent) throw new Error("Expected the processing snapshot fixture to include an event");
const wahooDatasetLabels = [
  ["activity", "Activities"],
  ["sleep", "Sleep"],
  ["recovery", "Recovery"],
  ["training", "Training"],
  ["body", "Body"],
  ["providers", "Provider summaries"],
] as const;

function failedWahooSnapshot(overrides: Partial<ProcessingStatusSnapshot> = {}) {
  const failedDatasets = wahooDatasetLabels.map(([key, label]) => ({
    ...activityDataset,
    key,
    label,
    status: "failed" as const,
    progressPercentage: null,
    lastReadyAt: "2026-07-22T16:00:00.000Z",
    lastFailedAt: "2026-07-22T16:05:00.000Z",
  }));
  return {
    ...snapshot,
    generatedAt: "2026-07-22T16:10:00.000Z",
    scope: { providerId: "wahoo", datasets: failedDatasets.map((dataset) => dataset.key) },
    overallStatus: "failed" as const,
    datasets: failedDatasets,
    operations: [
      {
        ...operation,
        id: "00000000-0000-4000-8000-00000000f501",
        providerId: "wahoo",
        status: "failed" as const,
        datasets: failedDatasets.map((dataset) => dataset.key),
        dismissed: false,
        errorCode: "provider_sync_failed",
        errorMessage: "Wahoo could not be synced. Try the sync again later.",
        timeline: [],
      },
    ],
    ...overrides,
  } satisfies ProcessingStatusSnapshot;
}

describe("ProcessingStatusWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDismissState.error = null;
    mockDismissState.isPending = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each(["failed", "blocked"] as const)(
    "surfaces %s datasets, their last ready age, and the actionable error",
    (status) => {
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
                lastFailedAt: "2026-07-22T13:00:00.000Z",
                lastReadyAt: "2026-07-22T12:00:00.000Z",
              },
            ],
            operations: [
              {
                ...operation,
                status,
                dismissed: false,
                errorMessage: "Reconnect Garmin, then start the sync again.",
                errorCode: "provider_auth_failed",
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
      expect(
        screen.getByText(`${status === "failed" ? "Failed" : "Blocked"}: 1h ago`),
      ).toBeTruthy();
      expect(screen.getByText("Last successful update: 2h ago")).toBeTruthy();
      expect(screen.getByText("Reconnect Garmin, then start the sync again.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Reconnect Garmin" }));
      expect(mockPush).toHaveBeenCalledWith("/providers/garmin");
    },
  );

  it("groups current failed datasets by operation and offers dismissal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T16:05:00.000Z"));

    render(<ProcessingStatusWidget data={failedWahooSnapshot()} />);

    expect(screen.getByText("Wahoo sync didn’t finish")).toBeTruthy();
    expect(screen.getAllByText("Activities")).toHaveLength(1);
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("Training")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("Provider summaries")).toBeTruthy();
    expect(screen.getByText("Failed: 16d ago")).toBeTruthy();
    expect(screen.getByText("Last successful update: 16d ago")).toBeTruthy();
    expect(screen.getByText("Wahoo could not be synced. Try the sync again later.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Wahoo" })).toBeNull();
    expect(
      screen.queryByText("Try the update again. If it still fails, reconnect the data source."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss Wahoo sync failure" })).toBeTruthy();
  });

  it("dismisses a failure group by operation and refreshes the status query", async () => {
    render(<ProcessingStatusWidget data={failedWahooSnapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Wahoo sync failure" }));

    expect(mockDismissOperation).toHaveBeenCalledWith({
      operationId: "00000000-0000-4000-8000-00000000f501",
    });
    await waitFor(() => expect(mockInvalidateStatus).toHaveBeenCalledOnce());
    expect(mockInvalidateAlerts).toHaveBeenCalledOnce();
  });

  it("disables the dismiss button while dismissal is pending", () => {
    mockDismissState.isPending = true;

    render(<ProcessingStatusWidget data={failedWahooSnapshot()} />);

    expect(
      screen
        .getByRole("button", { name: "Dismiss Wahoo sync failure" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("hides dismissed failure groups even when the widget is always visible", () => {
    const currentSnapshot = failedWahooSnapshot();
    const currentOperation = currentSnapshot.operations.at(0);
    if (!currentOperation) throw new Error("Expected a current operation");
    const dismissedSnapshot = failedWahooSnapshot({
      operations: [{ ...currentOperation, dismissed: true }],
    });

    expect(
      render(<ProcessingStatusWidget data={dismissedSnapshot} alwaysVisible />).container.innerHTML,
    ).toBe("");
  });

  it("keeps active processing visible when a separate failure was dismissed", () => {
    const currentSnapshot = failedWahooSnapshot();
    const failedDataset = currentSnapshot.datasets.at(0);
    const activeDataset = currentSnapshot.datasets.at(1);
    const currentOperation = currentSnapshot.operations.at(0);
    if (!failedDataset || !activeDataset || !currentOperation) {
      throw new Error("Expected current processing fixtures");
    }

    render(
      <ProcessingStatusWidget
        data={failedWahooSnapshot({
          datasets: [
            { ...failedDataset, status: "failed" },
            { ...activeDataset, status: "active", lastFailedAt: null },
          ],
          operations: [
            { ...currentOperation, dismissed: true },
            {
              ...currentOperation,
              id: "00000000-0000-4000-8000-00000000f502",
              status: "active",
              datasets: ["sleep"],
              dismissed: false,
              errorMessage: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Syncing Wahoo")).toBeTruthy();
    expect(screen.getByText("Sleep")).toBeTruthy();
  });

  it("does not render an older failed group after the dataset is ready again", () => {
    render(
      <ProcessingStatusWidget
        data={failedWahooSnapshot({
          overallStatus: "ready",
          datasets: [
            {
              ...activityDataset,
              status: "ready",
              progressPercentage: 100,
              lastFailedAt: "2026-07-22T16:05:00.000Z",
            },
          ],
          operations: [
            {
              ...operation,
              status: "failed",
              errorMessage: "This older failure is resolved.",
              dismissed: false,
            },
          ],
        })}
        alwaysVisible
      />,
    );

    expect(screen.queryByText("This older failure is resolved.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss Wahoo sync failure" })).toBeNull();
  });

  it("shows one operation-level mutation error after a dismiss attempt fails", () => {
    mockDismissState.error = new Error("Could not dismiss this sync failure.");

    render(<ProcessingStatusWidget data={failedWahooSnapshot()} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("Could not dismiss this sync failure.")).toHaveLength(1);
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
              lastFailedAt: null,
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
              lastFailedAt: null,
            },
          ],
          operations: [
            {
              ...operation,
              status: "ready",
              dismissed: false,
              errorMessage: null,
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
              lastFailedAt: "2026-07-22T13:00:00.000Z",
            },
          ],
          operations: [
            {
              ...operation,
              status: "failed",
              errorMessage: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText(/Failed:/)).toBeTruthy();
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
              lastFailedAt: null,
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
