/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeveloperClientSupportItem,
  DeveloperClientsAdminPanel,
  DeveloperClientsAdminPanelContent,
} from "./DeveloperClientsAdminPanel.tsx";

const mocks = vi.hoisted(() => ({
  externalClientsInvalidate: vi.fn(),
  externalClientsUseQuery: vi.fn(),
  revokeExternalClientMutate: vi.fn(),
  revokeExternalClientUseMutation: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    admin: {
      externalClients: { useQuery: mocks.externalClientsUseQuery },
      revokeExternalClient: { useMutation: mocks.revokeExternalClientUseMutation },
    },
    useUtils: () => ({
      admin: { externalClients: { invalidate: mocks.externalClientsInvalidate } },
    }),
  },
}));

const activeClient = {
  clientId: "ext_active",
  name: "Meal importer",
  ownerName: "Ada Owner",
  ownerEmail: "ada@example.test",
  scopes: ["nutrition:write"],
  status: "active",
  createdAt: "2026-08-24T20:00:00.000Z",
  lastRotatedAt: "2026-08-24T21:00:00.000Z",
} satisfies DeveloperClientSupportItem;

const revokedClient = {
  ...activeClient,
  clientId: "ext_revoked",
  name: "Retired importer",
  ownerName: null,
  ownerEmail: null,
  status: "revoked",
} satisfies DeveloperClientSupportItem;

describe("DeveloperClientsAdminPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.externalClientsInvalidate.mockReset();
    mocks.externalClientsInvalidate.mockResolvedValue(undefined);
    mocks.externalClientsUseQuery.mockReset();
    mocks.externalClientsUseQuery.mockReturnValue({
      data: [activeClient, revokedClient],
      error: null,
      isLoading: false,
    });
    mocks.revokeExternalClientMutate.mockReset();
    mocks.revokeExternalClientUseMutation.mockReset();
    mocks.revokeExternalClientUseMutation.mockImplementation(
      (options: { onSuccess?: () => Promise<void> | void }) => ({
        error: null,
        isPending: false,
        mutate: (input: { clientId: string }) => {
          mocks.revokeExternalClientMutate(input);
          void options.onSuccess?.();
        },
      }),
    );
  });

  it("renders distinct loading, query-error, and empty states", () => {
    mocks.externalClientsUseQuery.mockReturnValueOnce({
      data: undefined,
      error: null,
      isLoading: true,
    });
    const { unmount } = render(<DeveloperClientsAdminPanel />);
    expect(screen.getByLabelText("Loading developer integrations.")).toBeTruthy();
    unmount();

    mocks.externalClientsUseQuery.mockReturnValueOnce({
      data: undefined,
      error: new Error("Support inventory unavailable"),
      isLoading: false,
    });
    const errorRender = render(<DeveloperClientsAdminPanel />);
    expect(screen.getByText("Support inventory unavailable")).toBeTruthy();
    errorRender.unmount();

    mocks.externalClientsUseQuery.mockReturnValueOnce({ data: [], error: null, isLoading: false });
    render(<DeveloperClientsAdminPanel />);
    expect(screen.getByText("No developer integrations are registered.")).toBeTruthy();
  });

  it("renders active and revoked rows with safe owner attribution only", () => {
    render(<DeveloperClientsAdminPanel />);

    expect(screen.getByText("Meal importer")).toBeTruthy();
    expect(screen.getByText("Retired importer")).toBeTruthy();
    expect(screen.getByText("Ada Owner")).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect(screen.getByText("Owner unavailable")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("revoked")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret hash|grant|subject|audit|owner user id/i);
  });

  it("requires explicit confirmation and invalidates only the support inventory", async () => {
    render(<DeveloperClientsAdminPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Meal importer" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.revokeExternalClientMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(mocks.revokeExternalClientMutate).toHaveBeenCalledWith({ clientId: "ext_active" });
    expect(mocks.externalClientsInvalidate).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("protects the confirmation dialog while revocation is pending", () => {
    render(
      <DeveloperClientsAdminPanelContent
        clients={[activeClient, revokedClient]}
        error={null}
        isLoading={false}
        isRevoking
        mutationError={null}
        onCancelRevoke={vi.fn()}
        onConfirmRevoke={vi.fn()}
        onRequestRevoke={vi.fn()}
        selectedClient={activeClient}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Revoking…" });
    expect(confirm).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  });

  it("surfaces the server mutation error without hiding the client list", () => {
    mocks.revokeExternalClientUseMutation.mockReturnValue({
      error: new Error("The developer integration was not found or is already revoked."),
      isPending: false,
      mutate: mocks.revokeExternalClientMutate,
    });
    render(<DeveloperClientsAdminPanel />);

    expect(
      screen.getByText("The developer integration was not found or is already revoked."),
    ).toBeTruthy();
    expect(screen.getByText("Meal importer")).toBeTruthy();
  });
});
