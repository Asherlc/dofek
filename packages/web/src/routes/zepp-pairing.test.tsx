import { isValidElement } from "react";
import { expect, it, vi } from "vitest";

const captured = vi.hoisted<{
  validateSearch: ((search: Record<string, unknown>) => { code?: string }) | null;
  component: (() => unknown) | null;
}>(() => ({ component: null, validateSearch: null }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      component?: () => unknown;
      validateSearch?: (search: Record<string, unknown>) => { code?: string };
    }) => {
      captured.component = options.component ?? null;
      captured.validateSearch = options.validateSearch ?? null;
      return { ...options, useSearch: () => ({ code: "ABC234" }) };
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
  expect(captured.validateSearch?.({ code: 42 })).toEqual({});
});

it("passes the validated direct-link code from the route into the pairing page", async () => {
  await import("./zepp-pairing.tsx");

  const element = captured.component?.();
  expect(isValidElement<{ initialCode?: string }>(element)).toBe(true);
  if (!isValidElement<{ initialCode?: string }>(element)) {
    throw new Error("Pairing route did not return a page element");
  }
  expect(element.props.initialCode).toBe("ABC234");
});
