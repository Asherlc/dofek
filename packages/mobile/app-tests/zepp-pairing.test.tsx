// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ZeppPairingScreen from "../app/zepp-pairing";

const routeState = vi.hoisted<{ params: Record<string, unknown> }>(() => ({
  params: { code: "ABC234" },
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => routeState.params,
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    companionPairing: {
      claim: {
        useMutation: () => ({
          data: null,
          error: null,
          isError: false,
          isPending: false,
          isSuccess: false,
          mutate: vi.fn(),
        }),
      },
    },
    companionToken: {
      list: {
        useQuery: () => ({
          data: [],
          error: null,
          isLoading: false,
          refetch: vi.fn().mockResolvedValue(undefined),
        }),
      },
      revoke: {
        useMutation: () => ({ error: null, mutate: vi.fn() }),
      },
    },
  },
}));

beforeEach(() => {
  routeState.params = { code: "ABC234" };
});

it("prefills the code on the dedicated mobile pairing screen", () => {
  render(<ZeppPairingScreen />);

  expect(screen.getByPlaceholderText("Short code").getAttribute("value")).toBe("ABC234");
});

it("normalizes and validates the pairing code from the route boundary", () => {
  routeState.params = { code: "  ABC234  " };
  const { unmount } = render(<ZeppPairingScreen />);

  expect(screen.getByPlaceholderText("Short code").getAttribute("value")).toBe("ABC234");
  unmount();

  routeState.params = { code: ["ABC234"] };
  render(<ZeppPairingScreen />);

  expect(screen.getByPlaceholderText("Short code").getAttribute("value")).toBe("");
});
