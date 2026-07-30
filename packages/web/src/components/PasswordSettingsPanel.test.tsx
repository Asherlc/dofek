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

  it("shows shared requirements, password-manager semantics, visibility controls, and Caps Lock", () => {
    mockStatusQuery.mockReturnValue({
      data: { hasPassword: true },
      isLoading: false,
      error: null,
    });
    mockSetPasswordMutation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    });

    render(<PasswordSettingsPanel />);

    const currentPassword = screen.getByLabelText("Current password");
    const newPassword = screen.getByLabelText("New password");
    const confirmPassword = screen.getByLabelText("Confirm password");

    expect(currentPassword.getAttribute("autocomplete")).toBe("current-password");
    expect(newPassword.getAttribute("autocomplete")).toBe("new-password");
    expect(newPassword.getAttribute("minlength")).toBe("8");
    expect(newPassword.getAttribute("maxlength")).toBe("128");
    expect(confirmPassword.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByText("Use 8–128 characters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show current password" }));
    expect(currentPassword.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide current password" }));
    expect(currentPassword.getAttribute("type")).toBe("password");

    const capsLockEvent = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(capsLockEvent, "getModifierState", {
      value: (modifier: string) => modifier === "CapsLock",
    });
    fireEvent(newPassword, capsLockEvent);
    expect(screen.getByRole("status")).toHaveTextContent("Caps Lock is on.");
  });

  it("blocks an invalid new password before calling the mutation", async () => {
    const mutateAsync = vi.fn();
    mockStatusQuery.mockReturnValue({
      data: { hasPassword: false },
      isLoading: false,
      error: null,
    });
    mockSetPasswordMutation.mockReturnValue({ mutateAsync, isPending: false, error: null });

    render(<PasswordSettingsPanel />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("Use at least 8 characters.")).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("requires the current password before changing an existing credential", async () => {
    const mutateAsync = vi.fn();
    mockStatusQuery.mockReturnValue({
      data: { hasPassword: true },
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
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Enter your current password.")).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
