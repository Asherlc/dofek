import { expect, it, vi } from "vitest";

const captured = vi.hoisted<{
  validateSearch: ((search: Record<string, unknown>) => { code?: string }) | null;
}>(() => ({ validateSearch: null }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: { validateSearch?: (search: Record<string, unknown>) => { code?: string } }) => {
      captured.validateSearch = options.validateSearch ?? null;
      return options;
    },
}));

vi.mock("../pages/ZeppPairingPage.tsx", () => ({
  ZeppPairingPage: () => null,
}));

it("keeps a non-empty Zepp pairing code from the direct URL", async () => {
  await import("./zepp-pairing.tsx");

  expect(captured.validateSearch?.({ code: "ABC234" })).toEqual({ code: "ABC234" });
  expect(captured.validateSearch?.({ code: "" })).toEqual({});
  expect(captured.validateSearch?.({ code: ["ABC234"] })).toEqual({});
});
