// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderDangerZone } from "./ProviderDangerZone.tsx";

const operationId = "30000000-0000-4000-8000-000000000001";
const mockMutateAsync = vi.fn().mockResolvedValue({ success: true, operationId });
const mockDisconnectMutateAsync = vi.fn().mockResolvedValue({ success: true });
const mockInvalidate = vi.fn().mockResolvedValue(undefined);
const { mockProcessingStatusInvalidate, mockDeletionStatusQuery } = vi.hoisted(() => ({
  mockProcessingStatusInvalidate: vi.fn().mockResolvedValue(undefined),
  mockDeletionStatusQuery: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      processing: {
        status: { invalidate: mockProcessingStatusInvalidate },
      },
      sync: {
        providers: { invalidate: mockInvalidate },
        providerStats: { invalidate: mockInvalidate },
      },
      providerDetail: {
        logs: { invalidate: mockInvalidate },
        records: { invalidate: mockInvalidate },
      },
    }),
    providerDetail: {
      disconnect: {
        useMutation: () => ({ isPending: false, mutateAsync: mockDisconnectMutateAsync }),
      },
      deleteAllData: {
        useMutation: () => ({ isPending: false, mutateAsync: mockMutateAsync }),
      },
      deletionStatus: {
        useQuery: mockDeletionStatusQuery,
      },
    },
  },
}));

beforeEach(() => {
  mockDeletionStatusQuery.mockReturnValue({
    data: { status: "running", message: "Deleting metric stream rows..." },
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderDangerZone", () => {
  it("groups disconnect and deletion in one danger zone with explicit impact copy", () => {
    render(<ProviderDangerZone canDisconnect providerId="strava" providerName="Strava" />);

    expect(screen.getAllByRole("heading", { name: "Danger Zone" })).toHaveLength(1);
    expect(
      screen.getByText(
        "Disconnecting Strava removes its saved authorization and stops future syncs. Data already imported into Dofek is kept.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Permanently delete every Strava record from Dofek. This does not change whether Strava is connected.",
      ),
    ).not.toBeNull();
  });

  it("names the provider in confirmation, focuses cancel, and submits only once", async () => {
    let resolveDisconnect: (() => void) | undefined;
    mockDisconnectMutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDisconnect = () => resolve({ success: true });
        }),
    );
    render(<ProviderDangerZone canDisconnect providerId="strava" providerName="Strava" />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Strava" }));

    expect(screen.getByRole("dialog", { name: "Disconnect Strava?" })).not.toBeNull();
    const cancel = screen.getByRole("button", { name: "Cancel disconnect" });
    await waitFor(() => expect(cancel).toHaveFocus());
    const confirm = screen.getByRole("button", { name: "Confirm disconnect Strava" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mockDisconnectMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockDisconnectMutateAsync).toHaveBeenCalledWith({ providerId: "strava" });
    await act(async () => resolveDisconnect?.());
  });

  it("shows generic operation progress after deletion is accepted", async () => {
    render(<ProviderDangerZone canDisconnect providerId="strava" providerName="Strava" />);

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
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Deleting provider data..." })).not.toBeNull();
  });

  it("keeps concurrent sync and deletion progress visible", async () => {
    render(
      <ProviderDangerZone
        canDisconnect
        providerId="strava"
        providerName="Strava"
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

  it("invalidates processing status when deletion completes", async () => {
    const { rerender } = render(
      <ProviderDangerZone canDisconnect providerId="strava" providerName="Strava" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete all data" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to confirm'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete data" }));
    await waitFor(() => expect(screen.getByRole("progressbar")).not.toBeNull());

    mockDeletionStatusQuery.mockReturnValue({
      data: { status: "completed", message: "Provider data deletion completed." },
      error: null,
    });
    rerender(<ProviderDangerZone canDisconnect providerId="strava" providerName="Strava" />);

    await waitFor(() => expect(mockProcessingStatusInvalidate).toHaveBeenCalledOnce());
  });

  it("names, focuses, and allows dismissal of the idle confirmation dialog", async () => {
    render(<ProviderDangerZone canDisconnect providerId="strava" providerName="Strava" />);

    const trigger = screen.getByRole("button", { name: "Delete all data" });
    trigger.focus();
    fireEvent.click(trigger);

    const input = screen.getByLabelText('Type "DELETE" to confirm');
    expect(screen.getByRole("dialog", { name: "Delete all provider data?" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
