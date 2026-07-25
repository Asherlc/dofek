// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseSearch = vi.hoisted(() => vi.fn());
const mockConfirmPasswordReset = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => {
  const ref: { component: (() => React.ReactElement) | null } = { component: null };
  return ref;
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => {
    captured.component = options.component;
    return {};
  },
  Link: ({ children }: { children: React.ReactNode }) => <a href="/login">{children}</a>,
  useSearch: mockUseSearch,
}));

vi.mock("../lib/auth.ts", () => ({
  confirmPasswordReset: mockConfirmPasswordReset,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

import "./reset-password.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Reset password route", () => {
  it("reports confirmation failures without the reset token or password", async () => {
    const error = new Error("Reset link has expired");
    const token = "reset-token-must-not-leak";
    const password = "new-password-must-not-leak";
    mockUseSearch.mockReturnValue({ token });
    mockConfirmPasswordReset.mockRejectedValue(error);
    if (!captured.component) throw new Error("Reset password route component not captured");
    const ResetPasswordPage = captured.component;

    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "auth.password-reset-confirm",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(password);
  });
});
