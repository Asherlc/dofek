import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenAuthModal } from "./auth-modals.tsx";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../lib/trpc", () => ({
  trpc: { tokenAuth: { connect: { useMutation: () => ({ mutateAsync: mocks.connect }) } } },
}));
vi.mock("../../lib/telemetry", () => ({ captureException: vi.fn() }));

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.connect.mockResolvedValue({ success: true });
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
    expect(screen.getByText("This key imports your public and private ascent notes.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "personal-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect theCrag" }));
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith({ providerId: "thecrag", token: "personal-key" }),
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
