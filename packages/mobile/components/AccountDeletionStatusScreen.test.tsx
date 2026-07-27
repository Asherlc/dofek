// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveMobileAccountErasurePreparation,
  saveMobileAccountErasureStatusCapability,
} from "../lib/account-erasure-storage";
import {
  AccountDeletionStatusScreen,
  AccountDeletionStatusView,
} from "./AccountDeletionStatusScreen";

const mockConfirm = vi.hoisted(() => vi.fn());
const mockStatus = vi.hoisted(() => vi.fn());
const mockPurge = vi.hoisted(() => vi.fn());
const mockBeginCleanup = vi.hoisted(() => vi.fn());
const mockBeginCleanupForNonce = vi.hoisted(() => vi.fn());
const mockFinishCleanup = vi.hoisted(() => vi.fn());
const mockIsCleanupLeaseCurrent = vi.hoisted(() => vi.fn(() => true));
const mockReplace = vi.hoisted(() => vi.fn());
const mockQueryClient = vi.hoisted(() => ({ clear: vi.fn() }));

vi.mock("../lib/trpc", () => ({
  trpc: {
    accountErasure: {
      confirm: {
        useMutation: () => ({ mutateAsync: mockConfirm }),
      },
      status: {
        useMutation: () => ({ mutateAsync: mockStatus }),
      },
    },
  },
}));

vi.mock("../lib/mobile-account-purge", () => ({
  purgeMobileAccountState: mockPurge,
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    beginAccountErasureCleanup: mockBeginCleanup,
    beginAccountErasureCleanupForNonce: mockBeginCleanupForNonce,
    finishAccountErasureCleanup: mockFinishCleanup,
    isAccountErasureCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
    user: null,
  }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...original, useQueryClient: () => mockQueryClient };
});

const waitingRetentionStatus = {
  completedAt: null,
  currentPhase: "processor_log_backup_retention",
  deadlineMissed: false,
  id: "11111111-1111-4111-8111-111111111111",
  message: "Active application stores are verified.",
  replayRetainedUntil: "2026-08-02T12:00:00.000Z",
  requestedAt: "2026-07-26T12:00:00.000Z",
  retentionUntil: "2026-08-25T12:00:00.000Z",
  status: "waiting_retention" as const,
};

describe("AccountDeletionStatusView", () => {
  afterEach(cleanup);

  it("distinguishes the active-store boundary from final retained-data verification", () => {
    render(
      <AccountDeletionStatusView
        capability={{
          cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
          requestId: waitingRetentionStatus.id,
          statusToken: "s".repeat(43),
        }}
        error={null}
        isLoading={false}
        localCleanupPending={false}
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        onSignIn={vi.fn()}
        status={waitingRetentionStatus}
      />,
    );

    expect(screen.getByText("Active application stores verified")).toBeTruthy();
    expect(screen.getAllByText(/August 2, 2026/)).not.toHaveLength(0);
    expect(screen.getAllByText(/August 25, 2026/)).not.toHaveLength(0);
    expect(screen.getByText(/Deletion is still in progress/i)).toBeTruthy();
  });

  it("shows the actual completion time when verification finishes after the deadline", () => {
    render(
      <AccountDeletionStatusView
        capability={{
          cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
          requestId: waitingRetentionStatus.id,
          statusToken: "s".repeat(43),
        }}
        error={null}
        isLoading={false}
        localCleanupPending={false}
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        onSignIn={vi.fn()}
        status={{
          ...waitingRetentionStatus,
          completedAt: "2026-08-26T12:34:00.000Z",
          currentPhase: "completed",
          deadlineMissed: true,
          message: null,
          status: "completed",
        }}
      />,
    );

    expect(screen.getByText(/August 26, 2026 at 12:34 PM UTC/)).toBeTruthy();
    expect(screen.getByText(/after the August 25, 2026 deadline/)).toBeTruthy();
  });

  it("offers sign-in when no status capability is saved", () => {
    const onSignIn = vi.fn();
    render(
      <AccountDeletionStatusView
        capability={null}
        error={null}
        isLoading={false}
        localCleanupPending={false}
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        onSignIn={onSignIn}
        status={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in to request account deletion" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("states iOS and processor retention limits accurately", () => {
    render(
      <AccountDeletionStatusView
        capability={null}
        error={null}
        isLoading={false}
        localCleanupPending={false}
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        onSignIn={vi.fn()}
        status={null}
      />,
    );

    expect(
      screen.getByText(/HealthKit and Core Motion source records remain controlled by iOS/i),
    ).toBeTruthy();
    expect(screen.getByText(/legally required transaction records/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Contact deletion support" })).toBeTruthy();
  });

  it("does not allow a new sign-in while local cleanup remains pending", () => {
    render(
      <AccountDeletionStatusView
        capability={{
          cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
          localCleanupPending: true,
          requestId: waitingRetentionStatus.id,
          statusToken: "s".repeat(43),
        }}
        error={null}
        isLoading={false}
        localCleanupPending
        onForget={undefined}
        onRefresh={vi.fn()}
        onSignIn={vi.fn()}
        status={waitingRetentionStatus}
      />,
    );

    expect(screen.queryByRole("button", { name: "Forget saved status" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in/i })).toBeNull();
  });

  it("explains when cleanup is fenced by another local account generation", () => {
    render(
      <AccountDeletionStatusView
        capability={{
          cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
          localCleanupBlockedByAnotherSession: true,
          localCleanupPending: true,
          requestId: waitingRetentionStatus.id,
          statusToken: "s".repeat(43),
        }}
        error={null}
        isLoading={false}
        localCleanupPending
        onForget={undefined}
        onRefresh={vi.fn()}
        onSignIn={vi.fn()}
        status={waitingRetentionStatus}
      />,
    );

    expect(screen.getByText(/another account is active on this device/i)).toBeTruthy();
  });
});

describe("AccountDeletionStatusScreen", () => {
  const cleanupLease = {
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus.mockResolvedValue(waitingRetentionStatus);
    mockConfirm.mockResolvedValue({
      replayRetainedUntil: waitingRetentionStatus.replayRetainedUntil,
      requestId: waitingRetentionStatus.id,
      retentionUntil: waitingRetentionStatus.retentionUntil,
      statusToken: "s".repeat(43),
    });
    mockPurge.mockResolvedValue({ errors: [] });
    mockBeginCleanup.mockReturnValue(cleanupLease);
    mockBeginCleanupForNonce.mockReturnValue(cleanupLease);
  });

  afterEach(cleanup);

  it("recovers a lost confirmation response and repeats local purge", async () => {
    await saveMobileAccountErasurePreparation({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });

    render(<AccountDeletionStatusScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover deletion status" }));

    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith({ preparationToken: "p".repeat(43) }),
    );
    await waitFor(() => expect(mockStatus).toHaveBeenCalledWith({ statusToken: "s".repeat(43) }));
    expect(mockBeginCleanupForNonce).toHaveBeenCalledWith(cleanupLease.cleanupOwnerNonce);
    expect(mockPurge).toHaveBeenCalledWith({
      cleanupLease,
      isCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
      queryClient: mockQueryClient,
    });
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
  });

  it("keeps the capability and offers retry when local cleanup fails", async () => {
    await saveMobileAccountErasurePreparation({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });
    mockPurge.mockResolvedValueOnce({ errors: [new Error("Keychain unavailable")] });

    render(<AccountDeletionStatusScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Recover deletion status" }));

    expect(await screen.findByRole("button", { name: "Retry local cleanup" })).toBeTruthy();
  });

  it("runs a local cleanup retry under the saved owner's cleanup lease", async () => {
    await saveMobileAccountErasureStatusCapability({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      localCleanupPending: true,
      requestId: waitingRetentionStatus.id,
      statusToken: "s".repeat(43),
    });

    render(<AccountDeletionStatusScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry local cleanup" }));

    await waitFor(() =>
      expect(mockBeginCleanupForNonce).toHaveBeenCalledWith(cleanupLease.cleanupOwnerNonce),
    );
    expect(mockPurge).toHaveBeenCalledWith({
      cleanupLease,
      isCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
      queryClient: mockQueryClient,
    });
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
  });

  it("drops in-memory auth when status persistence fails after recovery acceptance", async () => {
    await saveMobileAccountErasurePreparation({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });
    render(<AccountDeletionStatusScreen />);
    const SecureStore = await import("expo-secure-store");
    const setItem = vi.mocked(SecureStore.setItemAsync);
    const originalSetItem = setItem.getMockImplementation();
    setItem.mockImplementation((key, ...args) => {
      if (key === "dofek_account_erasure_status_v1") {
        return Promise.reject(new Error("Keychain unavailable"));
      }
      return originalSetItem?.(key, ...args) ?? Promise.resolve();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Recover deletion status" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledOnce());
    expect(mockBeginCleanupForNonce).toHaveBeenCalledWith(cleanupLease.cleanupOwnerNonce);
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
    expect(mockPurge).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("Keychain unavailable");
    if (originalSetItem) setItem.mockImplementation(originalSetItem);
  });

  it("keeps the global gate through recovery cleanup after the status screen unmounts", async () => {
    await saveMobileAccountErasurePreparation({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });
    let resolvePurge: ((result: { errors: Error[] }) => void) | undefined;
    mockPurge.mockImplementationOnce(
      () =>
        new Promise<{ errors: Error[] }>((resolve) => {
          resolvePurge = resolve;
        }),
    );
    const rendered = render(<AccountDeletionStatusScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover deletion status" }));
    await waitFor(() => expect(mockPurge).toHaveBeenCalledOnce());
    rendered.unmount();
    expect(mockFinishCleanup).not.toHaveBeenCalled();

    resolvePurge?.({ errors: [] });
    await waitFor(() => expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease));
  });
});
