// @vitest-environment jsdom
import { surfaceColors, textColors } from "@dofek/scoring/colors";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader.tsx";

function relativeLuminance(hexColor: string): number {
  const linearChannel = (start: number) => {
    const channel = Number.parseInt(hexColor.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: () => ({
    user: { name: "Ada Lovelace", email: "ada@example.com", isAdmin: false },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    to,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    className?: string;
    to: string;
    "aria-label"?: string;
  }) => (
    <a href={to} className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

describe("AppHeader", () => {
  afterEach(() => {
    cleanup();
  });

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

  it("uses an AA-contrast navigation token for sign-out actions", () => {
    render(<AppHeader />);

    const signOutActions = screen.getAllByRole("button", { name: "Sign out" });
    expect(signOutActions).toHaveLength(2);
    for (const signOutAction of signOutActions) {
      expect(signOutAction.classList.contains("text-muted")).toBe(true);
    }
    expect(contrastRatio(textColors.secondary, surfaceColors.background)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("exposes mobile navigation state to assistive technology", () => {
    render(<AppHeader />);

    const menuButton = screen.getByLabelText("Toggle navigation menu");
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    expect(menuButton.getAttribute("aria-controls")).toBe("app-mobile-navigation");

    fireEvent.click(menuButton);

    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Mobile").getAttribute("id")).toBe("app-mobile-navigation");
  });

  it("renders primary app destinations and the signed-in user", () => {
    render(<AppHeader />);

    expect(screen.getAllByText("Overview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nutrition").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reports").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "More" })).toHaveLength(2);
    for (const moreLink of screen.getAllByRole("link", { name: "More" })) {
      expect(moreLink.getAttribute("href")).toBe("/more");
    }
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("does not include Settings in the main sidebar nav and links the user card to settings", () => {
    render(<AppHeader />);

    const sections = screen.getByRole("navigation", { name: "Sections" });
    expect(sections.textContent).not.toContain("Settings");

    const settingsLink = screen.getByLabelText("Open settings");
    expect(settingsLink.getAttribute("href")).toBe("/settings");
    expect(settingsLink.textContent).toContain("Ada Lovelace");
  });

  it("shows active alerts in the desktop sidebar and mobile header", () => {
    render(<AppHeader activeAlertCount={1} />);

    expect(screen.getAllByLabelText("Alerts, 1 active")).toHaveLength(2);
    expect(screen.getAllByText("1")).toHaveLength(2);
  });
});
