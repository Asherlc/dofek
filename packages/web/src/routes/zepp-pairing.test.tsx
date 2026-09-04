// @vitest-environment jsdom

import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";

const captured = vi.hoisted<{
  validateSearch: ((search: Record<string, unknown>) => { code?: string }) | null;
  component: (() => ReactElement<{ initialCode?: string }>) | null;
  pageProps: { initialCode?: string } | null;
}>(() => ({ component: null, pageProps: null, validateSearch: null }));

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
  ZeppPairingPage: (props: { initialCode?: string }) => {
    captured.pageProps = props;
    return <div data-testid="zepp-pairing-page" />;
  },
}));

it("keeps a non-empty Zepp pairing code from the direct URL", async () => {
  await import("./zepp-pairing.tsx");

  expect(captured.validateSearch?.({ code: "ABC234" })).toEqual({ code: "ABC234" });
  expect(captured.validateSearch?.({ code: "  ABC234  " })).toEqual({ code: "ABC234" });
  expect(captured.validateSearch?.({ code: "" })).toEqual({});
  expect(captured.validateSearch?.({ code: ["ABC234"] })).toEqual({});
  expect(captured.validateSearch?.({ code: 42 })).toEqual({});
});

it("passes the validated direct-link code from the route into the pairing page", async () => {
  await import("./zepp-pairing.tsx");

  expect(captured.component).not.toBeNull();
  if (!captured.component) throw new Error("Zepp pairing route component was not registered");
  render(captured.component());

  expect(captured.pageProps?.initialCode).toBe("ABC234");
});
