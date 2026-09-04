// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ZeppPairingPanel } from "./ZeppPairingPanel.tsx";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  refetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    companionPairing: {
      claim: {
        useMutation: () => ({
          data: null,
          error: null,
          isError: false,
          isPending: false,
          isSuccess: false,
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
        useMutation: () => ({ error: null, mutate: vi.fn() }),
      },
    },
  },
}));

it("prefills and submits the pairing code from a direct pairing URL", () => {
  render(<ZeppPairingPanel initialCode="ABC234" />);

  expect(screen.getByRole("textbox", { name: "Short code" }).getAttribute("value")).toBe("ABC234");
  fireEvent.click(screen.getByRole("button", { name: "Connect Zepp App" }));
  expect(mocks.claim).toHaveBeenCalledWith({ code: "ABC234" });
});
