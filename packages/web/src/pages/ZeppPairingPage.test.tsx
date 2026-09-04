// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { ZeppPairingPage } from "./ZeppPairingPage.tsx";

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title: string }) => (
    <main aria-label={title}>{children}</main>
  ),
}));

vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

vi.mock("../components/ZeppPairingPanel.tsx", () => ({
  ZeppPairingPanel: ({ initialCode }: { initialCode?: string }) => <p>{initialCode}</p>,
}));

it("renders the dedicated Zepp pairing surface with the direct-link code", () => {
  render(<ZeppPairingPage initialCode="ABC234" />);

  expect(screen.getByRole("main", { name: "Pair Zepp App" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Zepp App Pairing" })).toBeTruthy();
  expect(screen.getByText("ABC234")).toBeTruthy();
});
