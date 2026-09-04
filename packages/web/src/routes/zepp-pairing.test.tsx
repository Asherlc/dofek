import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";

const captured = vi.hoisted<{
  validateSearch: ((search: Record<string, unknown>) => { code?: string }) | null;
  component: (() => ReactElement<{ initialCode?: string }>) | null;
}>(() => ({ component: null, validateSearch: null }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      component?: () => ReactElement<{ initialCode?: string }>;
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
});

it("passes the validated direct-link code from the route into the pairing page", async () => {
  await import("./zepp-pairing.tsx");

  expect(captured.component?.().props.initialCode).toBe("ABC234");
});
