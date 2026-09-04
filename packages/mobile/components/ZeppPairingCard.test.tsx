import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZeppPairingCard, ZeppPairingCardBody } from "./ZeppPairingCard";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  refetch: vi.fn().mockResolvedValue(undefined),
  revoke: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    companionPairing: {
      claim: {
        useMutation: () => ({
          error: null,
          isError: false,
          isPending: false,
          mutate: mocks.claim,
        }),
      },
    },
    companionToken: {
      list: {
        useQuery: () => ({
          data: [],
          error: null,
          isLoading: false,
          refetch: mocks.refetch,
        }),
      },
      revoke: {
        useMutation: () => ({ error: null, mutate: mocks.revoke }),
      },
    },
  },
}));

const defaultProps = {
  connections: [],
  connectionsError: null,
  disconnectError: null,
  isConnectionsLoading: false,
  pairingCode: "",
  pairingMessage: "",
  isError: false,
  isPending: false,
  onPairingCodeChange: vi.fn(),
  onClaimPairing: vi.fn(),
  onDisconnect: vi.fn(),
};

describe("ZeppPairingCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the pairing code when the direct-link code changes", () => {
    const { rerender } = render(<ZeppPairingCard initialCode="ABC234" />);

    rerender(<ZeppPairingCard initialCode="XYZ789" />);

    expect(screen.getByPlaceholderText("Short code").getAttribute("value")).toBe("XYZ789");
    fireEvent.click(screen.getByRole("button", { name: "Connect Zepp App" }));
    expect(mocks.claim).toHaveBeenCalledWith({ code: "XYZ789" });
  });
});

describe("ZeppPairingCardBody", () => {
  it("renders loading, error, and empty connection states separately", () => {
    const { rerender } = render(<ZeppPairingCardBody {...defaultProps} isConnectionsLoading />);
    expect(screen.getByText("Checking connections…")).toBeTruthy();

    rerender(<ZeppPairingCardBody {...defaultProps} connectionsError="Connection query failed" />);
    expect(screen.getByText("Connection query failed")).toBeTruthy();

    rerender(<ZeppPairingCardBody {...defaultProps} />);
    expect(screen.getByText("No Zepp apps connected")).toBeTruthy();
  });

  it("renders both connection types and disconnects the selected package", () => {
    const onDisconnect = vi.fn();
    render(
      <ZeppPairingCardBody
        {...defaultProps}
        connections={[{ connectionType: "zepp-main" }, { connectionType: "zepp-workout" }]}
        onDisconnect={onDisconnect}
      />,
    );

    expect(screen.getByText("Zepp app: Connected")).toBeTruthy();
    expect(screen.getByText("Workout extension: Connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Workout extension" }));
    expect(onDisconnect).toHaveBeenCalledWith("zepp-workout");
  });

  it("keeps active connections visible when disconnecting fails", () => {
    render(
      <ZeppPairingCardBody
        {...defaultProps}
        connections={[{ connectionType: "zepp-main" }]}
        disconnectError="Could not disconnect the Zepp app"
      />,
    );

    expect(screen.getByText("Zepp app: Connected")).toBeTruthy();
    expect(screen.getByText("Could not disconnect the Zepp app")).toBeTruthy();
  });
});
