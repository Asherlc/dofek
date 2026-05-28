// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader.tsx";

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: () => ({
    user: { name: "Ada Lovelace", email: "ada@example.com", isAdmin: false },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className, to }: { children: ReactNode; className?: string; to: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

describe("AppHeader", () => {
  it("renders desktop navigation as a sidebar evidence desk", () => {
    render(<AppHeader />);

    const sidebar = screen.getByLabelText("Primary navigation");
    expect(sidebar.tagName).toBe("ASIDE");
    expect(sidebar.className).toContain("lg:sticky");
    expect(sidebar.className).toContain("lg:w-[13.5rem]");
    expect(sidebar.className).toContain("border-border-strong");
  });

  it("keeps a compact mobile header for small screens", () => {
    render(<AppHeader />);

    const mobileHeader = screen.getByRole("banner");
    expect(mobileHeader.className).toContain("lg:hidden");
    expect(screen.getByLabelText("Toggle navigation menu")).toBeTruthy();
  });

  it("renders primary app destinations and the signed-in user", () => {
    render(<AppHeader />);

    expect(screen.getAllByText("Overview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nutrition").length).toBeGreaterThan(0);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });
});
