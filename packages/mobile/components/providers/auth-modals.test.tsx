import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialAuthModal, TokenAuthModal, WhoopAuthModal } from "./auth-modals.tsx";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), signIn: vi.fn() }));
vi.mock("../../lib/trpc", () => ({
  trpc: {
    tokenAuth: { connect: { useMutation: () => ({ mutateAsync: mocks.connect }) } },
    credentialAuth: { signIn: { useMutation: () => ({ mutateAsync: mocks.signIn }) } },
    whoopAuth: {
      signIn: { useMutation: () => ({ mutateAsync: mocks.signIn }) },
      verifyCode: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      saveTokens: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));
vi.mock("../../lib/telemetry", () => ({ captureException: vi.fn() }));

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.connect.mockResolvedValue({ success: true });
  mocks.signIn.mockReset();
  mocks.signIn.mockResolvedValue({ success: true });
});

describe("board account connection", () => {
  it.each(["tension", "grasshopper", "decoy", "soill", "touchstone", "aurora-board"])(
    "connects %s with a username keyboard and its exact trimmed username",
    async (providerId) => {
      const onSuccess = vi.fn();
      render(
        <CredentialAuthModal
          providerId={providerId}
          providerName="Climbing Board"
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />,
      );
      const username = screen.getByPlaceholderText("Username");
      expect(username.getAttribute("keyboardType")).toBe("default");
      expect(username.getAttribute("aria-label")).toBe("Username");
      expect(
        screen.getByText(
          "Use an existing board account after accepting its terms of use and privacy policy in the board app.",
        ),
      ).toBeTruthy();
      const signIn = screen.getByRole("button", { name: "Sign in to Climbing Board" });
      expect(signIn.getAttribute("aria-disabled")).toBe("true");
      expect(signIn.getAttribute("aria-description")).toBe(
        "Enter your username and password to continue.",
      );
      fireEvent.change(screen.getByPlaceholderText("Password"), {
        target: { value: "board-password" },
      });
      expect(signIn.getAttribute("aria-description")).toBe("Enter your username to continue.");
      fireEvent.change(username, { target: { value: "  Boulder.User_01  " } });
      fireEvent.click(signIn);
      await waitFor(() => {
        expect(mocks.signIn).toHaveBeenCalledWith({
          providerId,
          username: "Boulder.User_01",
          password: "board-password",
        });
        expect(onSuccess).toHaveBeenCalledOnce();
      });
    },
  );

  it.each(["kilter", "eight-sleep"])("keeps email entry for %s", (providerId) => {
    render(
      <CredentialAuthModal
        providerId={providerId}
        providerName="Email Provider"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText("Email").getAttribute("keyboardType")).toBe("email-address");
    expect(screen.getByText("Enter your email and password to continue.")).toBeTruthy();
  });

  it("keeps WHOOP custom sign-in on email entry", () => {
    render(<WhoopAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByPlaceholderText("Email").getAttribute("keyboardType")).toBe("email-address");
    expect(screen.getByText("Enter your email and password to continue.")).toBeTruthy();
  });
});

describe("theCrag personal key connection", () => {
  it("conceals and submits a personal key with its access disclosure", async () => {
    const onSuccess = vi.fn();
    render(
      <TokenAuthModal
        kind="access-token"
        providerId="thecrag"
        providerName="theCrag"
        tokenLabel="Personal API key"
        instructionsUrl="https://www.thecrag.com/en/article/logbookreadapi"
        description="This key imports your public and private ascent notes."
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />,
    );
    const input = screen.getByPlaceholderText("Personal API key");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("accessibilityHint")).toBe(
      "This key imports your public and private ascent notes.",
    );
    expect(screen.getByText("This key imports your public and private ascent notes.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "personal-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect theCrag" }));
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith({ providerId: "thecrag", token: "personal-key" }),
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
