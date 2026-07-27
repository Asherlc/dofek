// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveAccountErasurePreparation,
  saveAccountErasureStatusCapability,
} from "../lib/account-erasure-storage.ts";
import {
  AccountDeletionStatusPage,
  AccountDeletionStatusView,
} from "./AccountDeletionStatusPage.tsx";

const mockConfirm = vi.hoisted(() => vi.fn());
const mockStatus = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockPurge = vi.hoisted(() => vi.fn());
const mockDisablePostHog = vi.hoisted(() => vi.fn());
const mockBeginCleanup = vi.hoisted(() => vi.fn());
const mockBeginCleanupForNonce = vi.hoisted(() => vi.fn());
const mockFinishCleanup = vi.hoisted(() => vi.fn());
const mockIsCleanupLeaseCurrent = vi.hoisted(() => vi.fn(() => true));
const mockQueryClient = vi.hoisted(() => ({ clear: vi.fn() }));
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
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

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
  }: {
    children: React.ReactNode;
    search?: { returnTo?: string };
    to: string;
  }) => <a href={search?.returnTo ? `${to}?returnTo=${search.returnTo}` : to}>{children}</a>,
  useNavigate: () => mockNavigate,
}));

vi.mock("../lib/account-erasure-purge.ts", () => ({
  purgeWebAccountState: mockPurge,
}));

vi.mock("../lib/posthog.ts", () => ({
  disablePostHogForAccountErasure: mockDisablePostHog,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: () => ({
    beginAccountErasureCleanup: mockBeginCleanup,
    beginAccountErasureCleanupForNonce: mockBeginCleanupForNonce,
    finishAccountErasureCleanup: mockFinishCleanup,
    isAccountErasureCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
  }),
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

  it("shows the seven-day active-store boundary separately from final retention", () => {
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
        status={waitingRetentionStatus}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Active application stores verified" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/August 2, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/August 25, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Deletion is still in progress/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Deletion complete$/i)).not.toBeInTheDocument();
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

    expect(screen.getByText(/August 26, 2026 at 12:34 PM UTC/)).toBeInTheDocument();
    expect(screen.getByText(/after the August 25, 2026 deadline/)).toBeInTheDocument();
  });

  it("accurately describes local and processor retention limits", () => {
    render(
      <AccountDeletionStatusView
        capability={null}
        error={null}
        isLoading={false}
        localCleanupPending={false}
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        status={null}
      />,
    );

    expect(
      screen.getByText(/HealthKit and Core Motion source records remain controlled by iOS/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/legally required transaction records/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact deletion support/i })).toHaveAttribute(
      "href",
      "mailto:asherlc@asherlc.com",
    );
  });

  it("offers an actionable sign-in path when no capability is saved", () => {
    render(
      <AccountDeletionStatusView
        capability={null}
        error={null}
        isLoading={false}
        localCleanupPending={false}
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        status={null}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Sign in to request account deletion" }),
    ).toHaveAttribute("href", "/login?returnTo=/settings");
  });

  it("surfaces blocked local cleanup and lets the user retry", () => {
    const onRetryLocalCleanup = vi.fn();
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
        onForget={vi.fn()}
        onRefresh={vi.fn()}
        onRetryLocalCleanup={onRetryLocalCleanup}
        status={waitingRetentionStatus}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/close other Dofek tabs/i);
    expect(screen.queryByRole("button", { name: "Forget saved status" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry local cleanup" }));
    expect(onRetryLocalCleanup).toHaveBeenCalledOnce();
  });

  it("explains when cleanup is fenced by another browser session generation", () => {
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
        status={waitingRetentionStatus}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /another account is active in this browser/i,
    );
  });
});

describe("AccountDeletionStatusPage", () => {
  const cleanupLease = {
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mockStatus.mockResolvedValue(waitingRetentionStatus);
    mockConfirm.mockResolvedValue({
      replayRetainedUntil: waitingRetentionStatus.replayRetainedUntil,
      requestId: waitingRetentionStatus.id,
      retentionUntil: waitingRetentionStatus.retentionUntil,
      statusToken: "s".repeat(43),
    });
    mockPurge.mockResolvedValue({ errors: [] });
    mockBeginCleanup.mockResolvedValue(cleanupLease);
    mockBeginCleanupForNonce.mockResolvedValue(cleanupLease);
  });

  afterEach(cleanup);

  it("loads status with the persisted public capability and no authenticated session", async () => {
    saveAccountErasureStatusCapability({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      requestId: waitingRetentionStatus.id,
      statusToken: "s".repeat(43),
    });

    render(<AccountDeletionStatusPage />);

    await waitFor(() => expect(mockStatus).toHaveBeenCalledWith({ statusToken: "s".repeat(43) }));
    expect(await screen.findByText(/Active application stores were verified/i)).toBeInTheDocument();
  });

  it("recovers a lost confirmation response using the attempted preparation", async () => {
    saveAccountErasurePreparation({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });

    render(<AccountDeletionStatusPage />);
    fireEvent.click(screen.getByRole("button", { name: "Recover deletion status" }));

    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith({ preparationToken: "p".repeat(43) }),
    );
    await waitFor(() => expect(mockStatus).toHaveBeenCalledWith({ statusToken: "s".repeat(43) }));
    expect(mockDisablePostHog).toHaveBeenCalledBefore(mockPurge);
    expect(mockBeginCleanupForNonce).toHaveBeenCalledWith(cleanupLease.cleanupOwnerNonce);
    expect(mockPurge).toHaveBeenCalledWith({
      cleanupLease,
      isCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
      queryClient: mockQueryClient,
    });
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
  });

  it("keeps the cleanup gate when a local cleanup retry fails", async () => {
    saveAccountErasureStatusCapability({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      localCleanupPending: true,
      requestId: waitingRetentionStatus.id,
      statusToken: "s".repeat(43),
    });
    mockPurge.mockRejectedValueOnce(new Error("Browser storage unavailable"));

    render(<AccountDeletionStatusPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry local cleanup" }));

    expect(await screen.findByText("Browser storage unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget saved status" })).not.toBeInTheDocument();
    expect(mockCaptureException).toHaveBeenCalledWith(
      new Error("Local account erasure cleanup retry failed."),
      { source: "account-erasure-cleanup-retry" },
    );
  });

  it("runs local cleanup retry under the persisted owner's lease", async () => {
    saveAccountErasureStatusCapability({
      cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce,
      localCleanupPending: true,
      requestId: waitingRetentionStatus.id,
      statusToken: "s".repeat(43),
    });

    render(<AccountDeletionStatusPage />);
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

  it("keeps the global gate through recovery cleanup after the page unmounts", async () => {
    saveAccountErasurePreparation({
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
    const rendered = render(<AccountDeletionStatusPage />);
    fireEvent.click(screen.getByRole("button", { name: "Recover deletion status" }));

    await waitFor(() => expect(mockPurge).toHaveBeenCalledOnce());
    rendered.unmount();
    expect(mockFinishCleanup).not.toHaveBeenCalled();

    resolvePurge?.({ errors: [] });
    await waitFor(() => expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease));
  });
});
