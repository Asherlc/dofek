// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ZeppPairingPanel, ZeppPairingPanelBody } from "./ZeppPairingPanel.tsx";

const mocks = vi.hoisted<{
  claim: ReturnType<typeof vi.fn>;
  connections: Array<{ connectionType: "zepp-main" | "zepp-workout" }>;
  connectionsError: Error | null;
  isConnectionsLoading: boolean;
  pairingOnSuccess: (() => Promise<void>) | null;
  refetch: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  revokeOnSuccess: (() => Promise<void>) | null;
}>(() => ({
  claim: vi.fn(),
  connections: [],
  connectionsError: null,
  isConnectionsLoading: false,
  pairingOnSuccess: null,
  refetch: vi.fn().mockResolvedValue(undefined),
  revoke: vi.fn(),
  revokeOnSuccess: null,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    companionPairing: {
      claim: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          mocks.pairingOnSuccess = options.onSuccess;
          return {
            data: null,
            error: null,
            isError: false,
            isPending: false,
            isSuccess: false,
            mutate: mocks.claim,
          };
        },
      },
    },
    companionToken: {
      list: {
        useQuery: () => ({
          data: mocks.connections,
          error: mocks.connectionsError,
          isLoading: mocks.isConnectionsLoading,
          refetch: mocks.refetch,
        }),
      },
      revoke: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          mocks.revokeOnSuccess = options.onSuccess;
          return { error: null, mutate: mocks.revoke };
        },
      },
    },
  },
}));

beforeEach(() => {
  mocks.claim.mockClear();
  mocks.connections = [];
  mocks.connectionsError = null;
  mocks.isConnectionsLoading = false;
  mocks.pairingOnSuccess = null;
  mocks.refetch.mockClear();
  mocks.revoke.mockClear();
  mocks.revokeOnSuccess = null;
});

it("prefills and submits the pairing code from a direct pairing URL", () => {
  render(<ZeppPairingPanel initialCode="ABC234" />);

  expect(screen.getByRole("textbox", { name: "Short code" }).getAttribute("value")).toBe("ABC234");
  fireEvent.click(screen.getByRole("button", { name: "Connect Zepp App" }));
  expect(mocks.claim).toHaveBeenCalledWith({ code: "ABC234" });
});

it("updates the pairing code when the direct-link code changes", () => {
  const { rerender } = render(<ZeppPairingPanel initialCode="ABC234" />);

  rerender(<ZeppPairingPanel initialCode="XYZ789" />);

  expect(screen.getByRole("textbox", { name: "Short code" }).getAttribute("value")).toBe("XYZ789");
  fireEvent.click(screen.getByRole("button", { name: "Connect Zepp App" }));
  expect(mocks.claim).toHaveBeenLastCalledWith({ code: "XYZ789" });
});

it("renders a failed connection query as an explicit query error state", () => {
  mocks.connectionsError = new Error("Could not load Zepp connections");

  render(<ZeppPairingPanel />);

  expect(screen.getByTestId("query-state-error")).toBeTruthy();
  expect(screen.getByText("Could not load Zepp connections")).toBeTruthy();
});

it("refreshes connections after successful pairing and disconnect", async () => {
  mocks.connections = [{ connectionType: "zepp-main" }];
  render(<ZeppPairingPanel initialCode="ABC234" />);

  await act(async () => mocks.pairingOnSuccess?.());
  expect(screen.getByRole("textbox", { name: "Short code" }).getAttribute("value")).toBe("");

  fireEvent.click(screen.getByRole("button", { name: "Disconnect Zepp app" }));
  expect(mocks.revoke).toHaveBeenCalledWith({ connectionType: "zepp-main" });
  await act(async () => mocks.revokeOnSuccess?.());

  expect(mocks.refetch).toHaveBeenCalledTimes(2);
});

it("shows connection loading and query errors", () => {
  const props = {
    connectionsState: { status: "loading" as const },
    disconnectError: null,
    isPairingError: false,
    isPairingPending: false,
    pairingCode: "",
    pairingMessage: null,
    onDisconnect: vi.fn(),
    onPairingCodeChange: vi.fn(),
    onSubmit: vi.fn(),
  };
  const { rerender } = render(<ZeppPairingPanelBody {...props} />);

  expect(screen.getByText("Checking connections…")).toBeTruthy();

  rerender(
    <ZeppPairingPanelBody
      {...props}
      connectionsState={{
        status: "error",
        error: new Error("Could not load Zepp connections"),
      }}
    />,
  );
  expect(screen.getByText("Could not load Zepp connections")).toBeTruthy();
});

it("renders connected and error states and forwards user actions", () => {
  const onDisconnect = vi.fn();
  const onPairingCodeChange = vi.fn();
  render(
    <ZeppPairingPanelBody
      connectionsState={{
        status: "success",
        connections: [{ connectionType: "zepp-main" }],
      }}
      disconnectError="Could not disconnect Zepp"
      isPairingError
      isPairingPending={false}
      pairingCode="ABC234"
      pairingMessage="Pairing code expired"
      onDisconnect={onDisconnect}
      onPairingCodeChange={onPairingCodeChange}
      onSubmit={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Disconnect Zepp app" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Short code" }), {
    target: { value: "XYZ789" },
  });

  expect(onDisconnect).toHaveBeenCalledWith("zepp-main");
  expect(onPairingCodeChange).toHaveBeenCalledWith("XYZ789");
  expect(screen.getByText("Could not disconnect Zepp")).toBeTruthy();
  expect(screen.getByText("Pairing code expired").className).toContain("text-red-400");
});
