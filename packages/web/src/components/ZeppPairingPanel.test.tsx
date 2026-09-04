// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ZeppPairingPanel, ZeppPairingPanelBody } from "./ZeppPairingPanel.tsx";

const mocks = vi.hoisted<{
  claim: ReturnType<typeof vi.fn>;
  connections: Array<{ connectionType: "zepp-main" | "zepp-workout" }>;
  pairingOnSuccess: (() => Promise<void>) | null;
  refetch: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  revokeOnSuccess: (() => Promise<void>) | null;
}>(() => ({
  claim: vi.fn(),
  connections: [],
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
          error: null,
          isLoading: false,
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
    connections: [],
    connectionsError: null,
    disconnectError: null,
    isConnectionsLoading: true,
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
      connectionsError="Could not load Zepp connections"
      isConnectionsLoading={false}
    />,
  );
  expect(screen.getByText("Could not load Zepp connections")).toBeTruthy();
});

it("renders connected and error states and forwards user actions", () => {
  const onDisconnect = vi.fn();
  const onPairingCodeChange = vi.fn();
  render(
    <ZeppPairingPanelBody
      connections={[{ connectionType: "zepp-main" }]}
      connectionsError={null}
      disconnectError="Could not disconnect Zepp"
      isConnectionsLoading={false}
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
