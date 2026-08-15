/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MorePage } from "./MorePage.tsx";

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({
    children,
    subtitle,
    title,
  }: {
    children: ReactNode;
    subtitle: string;
    title: string;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </main>
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

describe("MorePage", () => {
  it("exposes the secondary destinations as named links", () => {
    render(<MorePage />);

    expect(screen.getByRole("heading", { name: "More" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Account & settings/ }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(screen.getByRole("link", { name: /Cycle tracking/ }).getAttribute("href")).toBe(
      "/cycle",
    );
    expect(screen.getByRole("link", { name: /Data quality/ }).getAttribute("href")).toBe(
      "/data-quality",
    );
  });
});
