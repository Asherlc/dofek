// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordSettingsPanel } from "./PasswordSettingsPanel.tsx";

const mockStatusQuery = vi.fn();
const mockSetPasswordMutation = vi.fn();
const mockInvalidate = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    auth: {
      passwordCredentialStatus: { useQuery: () => mockStatusQuery() },
      setPassword: { useMutation: () => mockSetPasswordMutation() },
    },
    useUtils: () => ({ auth: { passwordCredentialStatus: { invalidate: mockInvalidate } } }),
  },
}));

describe("PasswordSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sets a password for users without a password credential", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ hasPassword: true });
    mockStatusQuery.mockReturnValue({
      data: { hasPassword: false },
      isLoading: false,
      error: null,
    });
    mockSetPasswordMutation.mockReturnValue({ mutateAsync, isPending: false, error: null });

    render(<PasswordSettingsPanel />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        { newPassword: "new-password123" },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      ),
    );
  });

  it("changes a password for users with a password credential", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ hasPassword: true });
    mockStatusQuery.mockReturnValue({ data: { hasPassword: true }, isLoading: false, error: null });
    mockSetPasswordMutation.mockReturnValue({ mutateAsync, isPending: false, error: null });

    render(<PasswordSettingsPanel />);

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        {
          currentPassword: "password123",
          newPassword: "new-password123",
        },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      ),
    );
  });
});
