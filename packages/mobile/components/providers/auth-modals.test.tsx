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

describe("theCrag public profile connection", () => {
  it("shows and submits a visible public identity", async () => {
    const onSuccess = vi.fn();
    render(
      <TokenAuthModal
        kind="public-profile"
        providerId="thecrag"
        providerName="theCrag"
        tokenLabel="theCrag profile URL or username"
        instructionsUrl="https://www.thecrag.com/"
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />,
    );
    const input = screen.getByPlaceholderText("theCrag profile URL or username");
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.change(input, { target: { value: "sampleclimber" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect theCrag" }));
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith({ providerId: "thecrag", token: "sampleclimber" }),
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
