// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ZeppPairingScreen from "../app/zepp-pairing";

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ code: "ABC234" }),
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

it("prefills the code on the dedicated mobile pairing screen", () => {
  render(<ZeppPairingScreen />);

  expect(screen.getByPlaceholderText("Short code").getAttribute("value")).toBe("ABC234");
});
