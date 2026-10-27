// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountErasureStatusCapability } from "../lib/account-erasure-storage.ts";
import { AccountErasurePanel } from "./AccountErasurePanel.tsx";

const mockPrepare = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn());
const mockPurge = vi.hoisted(() => vi.fn());
const mockDisablePostHog = vi.hoisted(() => vi.fn());
const mockBeginCleanup = vi.hoisted(() => vi.fn());
const mockFinishCleanup = vi.hoisted(() => vi.fn());
const mockIsCleanupLeaseCurrent = vi.hoisted(() => vi.fn(() => true));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockQueryClient = vi.hoisted(() => ({ clear: vi.fn() }));
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    accountErasure: {
      prepare: {
        useMutation: () => ({ error: null, isPending: false, mutateAsync: mockPrepare }),
      },
      confirm: {
        useMutation: () => ({ error: null, isPending: false, mutateAsync: mockConfirm }),
      },
    },
  },
}));

vi.mock("../lib/account-erasure-purge.ts", () => ({
  purgeWebAccountState: mockPurge,
}));

vi.mock("../lib/posthog.ts", () => ({
  disablePostHogForAccountErasure: mockDisablePostHog,
}));

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: () => ({
    beginAccountErasureCleanup: mockBeginCleanup,
    finishAccountErasureCleanup: mockFinishCleanup,
    isAccountErasureCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
    user: { id: "user-1", name: "Test", email: "test@example.com" },
  }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...original, useQueryClient: () => mockQueryClient };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

describe("AccountErasurePanel", () => {
  const cleanupLease = {
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockPrepare.mockResolvedValue({
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });
    mockConfirm.mockResolvedValue({
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestId: "11111111-1111-4111-8111-111111111111",
      retentionUntil: "2026-08-25T12:00:00.000Z",
      statusToken: "s".repeat(43),
    });
    mockPurge.mockImplementation(async () => {
      expect(loadAccountErasureStatusCapability()?.statusToken).toBe("s".repeat(43));
      return { errors: [] };
    });
    mockBeginCleanup.mockResolvedValue(cleanupLease);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("requires typed confirmation and a second irreversible action", async () => {
    render(<AccountErasurePanel />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const prepareButton = screen.getByRole("button", { name: "Prepare account deletion" });
    expect(prepareButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Type "DELETE" to continue'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(prepareButton);

    await screen.findByRole("button", { name: "Permanently delete my account" });
    expect(mockPrepare).toHaveBeenCalledWith({ confirmation: "DELETE" });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("stops analytics, marks the attempt, persists status, and purges in that order", async () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to continue'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: "/account-deletion" }));

    expect(mockDisablePostHog).toHaveBeenCalledBefore(mockConfirm);
    expect(mockBeginCleanup).toHaveBeenCalledBefore(mockConfirm);
    expect(mockConfirm).toHaveBeenCalledWith({ preparationToken: "p".repeat(43) });
    expect(mockConfirm).toHaveBeenCalledBefore(mockPurge);
    expect(mockBeginCleanup).toHaveBeenCalledWith("user-1");
    expect(mockPurge).toHaveBeenCalledWith({
      cleanupLease,
      isCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
      queryClient: mockQueryClient,
    });
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
    expect(loadAccountErasureStatusCapability()).toEqual(
      expect.objectContaining({ cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce }),
    );
    expect(localStorage.getItem("dofek:account-erasure:status:v1")).not.toContain("user-1");
  });

  it("keeps the preparation capability when a confirmation response is lost", async () => {
    mockConfirm.mockRejectedValueOnce(new Error("Network request failed"));
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to continue'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: "/account-deletion" }));
    const persistedAttempt = localStorage.getItem("dofek:account-erasure:preparation:v1");
    expect(persistedAttempt).toContain("confirmationAttemptedAt");
    expect(persistedAttempt).toContain(cleanupLease.cleanupOwnerNonce);
    expect(persistedAttempt).not.toContain("user-1");
    expect(await screen.findByText(/could not confirm the outcome/i)).toBeInTheDocument();
  });

  it("persists an actionable cleanup warning when browser purge is blocked", async () => {
    mockPurge.mockResolvedValueOnce({
      errors: [new Error("Upload storage deletion is blocked by another open Dofek tab")],
    });
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to continue'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() =>
      expect(loadAccountErasureStatusCapability()?.localCleanupPending).toBe(true),
    );
  });

  it("does not claim that Dofek deletes operating-system-owned health records", () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(
      screen.getByText(/HealthKit and Core Motion records remain controlled by iOS/i),
    ).toBeInTheDocument();
  });

  it("drops in-memory auth and enters public recovery when status persistence fails after acceptance", async () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to continue'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    await screen.findByRole("button", { name: "Permanently delete my account" });
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key !== "dofek:account-erasure:status:v1") {
        return originalSetItem.call(this, key, value);
      }
      throw new Error(`Storage quota exceeded user-1 ${"p".repeat(43)} ${"s".repeat(43)}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledOnce());
    expect(mockBeginCleanup).toHaveBeenCalledWith("user-1");
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/account-deletion" });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Check the account deletion status page for updates.",
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(
      /preparation|capability|confirmation response/i,
    );
    const telemetry = mockCaptureException.mock.calls
      .map(
        ([error, context]) =>
          `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(context)}`,
      )
      .join(" ");
    expect(telemetry).not.toContain("user-1");
    expect(telemetry).not.toContain("p".repeat(43));
    expect(telemetry).not.toContain("s".repeat(43));
    setItem.mockRestore();
  });

  it("keeps the app-wide gate until browser cleanup finishes after unmount", async () => {
    let resolvePurge: ((result: { errors: Error[] }) => void) | undefined;
    mockPurge.mockImplementationOnce(
      () =>
        new Promise<{ errors: Error[] }>((resolve) => {
          resolvePurge = resolve;
        }),
    );
    const rendered = render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByLabelText('Type "DELETE" to continue'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockPurge).toHaveBeenCalledOnce());
    rendered.unmount();
    expect(mockFinishCleanup).not.toHaveBeenCalled();

    resolvePurge?.({ errors: [] });
    await waitFor(() => expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease));
  });
});
