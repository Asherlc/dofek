// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobileAccountErasureStatusCapability } from "../lib/account-erasure-storage";
import { AccountErasurePanel } from "./AccountErasurePanel";

const mockPrepare = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn());
const mockPurge = vi.hoisted(() => vi.fn());
const mockBeginCleanup = vi.hoisted(() => vi.fn());
const mockFinishCleanup = vi.hoisted(() => vi.fn());
const mockIsCleanupLeaseCurrent = vi.hoisted(() => vi.fn(() => true));
const mockReplace = vi.hoisted(() => vi.fn());
const mockQueryClient = vi.hoisted(() => ({ clear: vi.fn() }));
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc", () => ({
  trpc: {
    accountErasure: {
      prepare: {
        useMutation: () => ({ isPending: false, mutateAsync: mockPrepare }),
      },
      confirm: {
        useMutation: () => ({ isPending: false, mutateAsync: mockConfirm }),
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
    finishAccountErasureCleanup: mockFinishCleanup,
    isAccountErasureCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
    user: { id: "user-1", name: "Test", email: "test@example.com" },
  }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...original, useQueryClient: () => mockQueryClient };
});

vi.mock("../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("mobile AccountErasurePanel", () => {
  const cleanupLease = {
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  };

  beforeEach(() => {
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
      expect((await loadMobileAccountErasureStatusCapability())?.statusToken).toBe("s".repeat(43));
      return { errors: [] };
    });
    mockBeginCleanup.mockReturnValue(cleanupLease);
  });

  afterEach(cleanup);

  it("requires typed confirmation and a distinct final action", async () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const prepareButton = screen.getByRole("button", { name: "Prepare account deletion" });
    expect(prepareButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Type "DELETE"'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(prepareButton);

    expect(
      await screen.findByRole("button", { name: "Permanently delete my account" }),
    ).toBeTruthy();
    expect(mockPrepare).toHaveBeenCalledWith({ confirmation: "DELETE" });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("persists status before native and JS purge, then clears local auth", async () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByPlaceholderText('Type "DELETE"'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/account-deletion"));
    expect(mockConfirm).toHaveBeenCalledWith({ preparationToken: "p".repeat(43) });
    expect(mockBeginCleanup).toHaveBeenCalledBefore(mockConfirm);
    expect(mockConfirm).toHaveBeenCalledBefore(mockPurge);
    expect(mockBeginCleanup).toHaveBeenCalledWith("user-1");
    expect(mockPurge).toHaveBeenCalledWith({
      cleanupLease,
      isCleanupLeaseCurrent: mockIsCleanupLeaseCurrent,
      queryClient: mockQueryClient,
    });
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
    expect(await loadMobileAccountErasureStatusCapability()).toEqual(
      expect.objectContaining({ cleanupOwnerNonce: cleanupLease.cleanupOwnerNonce }),
    );
    expect(JSON.stringify(await loadMobileAccountErasureStatusCapability())).not.toContain(
      "user-1",
    );
  });

  it("persists only the opaque cleanup nonce when the confirmation response is lost", async () => {
    mockConfirm.mockRejectedValueOnce(new Error("Network request failed"));
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByPlaceholderText('Type "DELETE"'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/account-deletion"));
    const SecureStore = await import("expo-secure-store");
    const persistedAttempt = await SecureStore.getItemAsync("dofek_account_erasure_preparation_v1");
    expect(persistedAttempt).toContain(cleanupLease.cleanupOwnerNonce);
    expect(persistedAttempt).toContain("confirmationAttemptedAt");
    expect(persistedAttempt).not.toContain("user-1");
    expect(mockBeginCleanup).toHaveBeenCalledBefore(mockConfirm);
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
  });

  it("never claims iOS-owned HealthKit or Core Motion source deletion", () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(
      screen.getByText(/HealthKit and Core Motion source records remain controlled by iOS/i),
    ).toBeTruthy();
  });

  it("drops in-memory auth immediately when status persistence fails after acceptance", async () => {
    render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByPlaceholderText('Type "DELETE"'), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare account deletion" }));
    await screen.findByRole("button", { name: "Permanently delete my account" });
    const SecureStore = await import("expo-secure-store");
    const setItem = vi.mocked(SecureStore.setItemAsync);
    const originalSetItem = setItem.getMockImplementation();
    setItem.mockImplementation((key, ...args) => {
      if (key === "dofek_account_erasure_status_v1") {
        return Promise.reject(
          new Error(`Keychain unavailable user-1 ${"p".repeat(43)} ${"s".repeat(43)}`),
        );
      }
      return originalSetItem?.(key, ...args) ?? Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledOnce());
    expect(mockBeginCleanup).toHaveBeenCalledWith("user-1");
    expect(mockFinishCleanup).toHaveBeenCalledWith(cleanupLease);
    expect(mockPurge).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Account deletion was accepted and your session was closed/i,
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
    if (originalSetItem) setItem.mockImplementation(originalSetItem);
  });

  it("keeps the app-wide gate until cleanup finishes after the panel unmounts", async () => {
    let resolvePurge: ((result: { errors: Error[] }) => void) | undefined;
    mockPurge.mockImplementationOnce(
      () =>
        new Promise<{ errors: Error[] }>((resolve) => {
          resolvePurge = resolve;
        }),
    );
    const rendered = render(<AccountErasurePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByPlaceholderText('Type "DELETE"'), {
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
