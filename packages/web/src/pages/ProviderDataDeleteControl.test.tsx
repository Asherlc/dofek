// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderDataDeleteControl } from "./ProviderDataDeleteControl.tsx";

const operationId = "30000000-0000-4000-8000-000000000001";
const mockMutateAsync = vi.fn().mockResolvedValue({ success: true, operationId });
const mockInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      sync: {
        providers: { invalidate: mockInvalidate },
        providerStats: { invalidate: mockInvalidate },
        dataHealth: { invalidate: mockInvalidate },
      },
      providerDetail: {
        logs: { invalidate: mockInvalidate },
        records: { invalidate: mockInvalidate },
      },
    }),
    providerDetail: {
      deleteAllData: {
        useMutation: () => ({ isPending: false, mutateAsync: mockMutateAsync }),
      },
      deletionStatus: {
        useQuery: () => ({
          data: { status: "running", message: "Deleting metric stream rows..." },
          error: null,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderDataDeleteControl", () => {
  it("shows generic operation progress after deletion is accepted", async () => {
    render(<ProviderDataDeleteControl providerId="strava" />);

    fireEvent.click(screen.getByRole("button", { name: "Delete all data" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to confirm'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete data" }));

    await waitFor(() => {
      expect(screen.getByRole("progressbar")).not.toBeNull();
    });
    expect(screen.getByText("Deleting metric stream rows...")).not.toBeNull();
    expect(mockMutateAsync).toHaveBeenCalledWith({
      providerId: "strava",
      confirmation: "DELETE",
    });
  });

  it("keeps concurrent sync and deletion progress visible", async () => {
    render(
      <ProviderDataDeleteControl
        providerId="strava"
        additionalOperations={[
          { id: "sync", label: "Provider sync", percentage: 35, message: "Syncing workouts" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete all data" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to confirm'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete data" }));

    await waitFor(() => expect(screen.getAllByRole("progressbar")).toHaveLength(2));
    expect(screen.getByText("Provider sync")).not.toBeNull();
    expect(screen.getByText("Provider data deletion")).not.toBeNull();
  });
});
