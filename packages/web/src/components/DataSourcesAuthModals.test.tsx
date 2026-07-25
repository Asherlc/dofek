// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialAuthModal, GarminAuthModal, WhoopAuthModal } from "./DataSourcesAuthModals.tsx";

const mutateAsync = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    credentialAuth: { signIn: { useMutation: () => ({ mutateAsync }) } },
    garminAuth: { signIn: { useMutation: () => ({ mutateAsync }) } },
    whoopAuth: {
      signIn: { useMutation: () => ({ mutateAsync }) },
      verifyCode: { useMutation: () => ({ mutateAsync }) },
      saveTokens: { useMutation: () => ({ mutateAsync }) },
    },
  },
}));

afterEach(cleanup);

describe("data source auth dialogs", () => {
  it.each([
    {
      name: "Connect Polar",
      renderDialog: (onClose: () => void) => (
        <CredentialAuthModal
          providerId="polar"
          providerName="Polar"
          onClose={onClose}
          onSuccess={() => {}}
        />
      ),
    },
    {
      name: "Connect Garmin",
      renderDialog: (onClose: () => void) => (
        <GarminAuthModal onClose={onClose} onSuccess={() => {}} />
      ),
    },
    {
      name: "Connect WHOOP",
      renderDialog: (onClose: () => void) => (
        <WhoopAuthModal onClose={onClose} onSuccess={() => {}} />
      ),
    },
  ])("makes $name accessible and keyboard-dismissible", async ({ name, renderDialog }) => {
    const onClose = vi.fn();
    render(renderDialog(onClose));

    const email = screen.getByLabelText("Email");
    expect(screen.getByRole("dialog", { name })).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(email).toHaveFocus());

    fireEvent.keyDown(email, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
