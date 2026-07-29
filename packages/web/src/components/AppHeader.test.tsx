// @vitest-environment jsdom
import { surfaceColors, textColors } from "@dofek/scoring/colors";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MouseEventHandler, ReactNode, Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    onClick,
    ref,
  }: {
    children: ReactNode;
    className?: string;
    to: string;
    "aria-label"?: string;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    ref?: Ref<HTMLAnchorElement>;
  }) => (
    <a
      href={to}
      className={className}
      aria-label={ariaLabel}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      ref={ref}
    >
      {children}
    </a>
  ),
}));

describe("AppHeader", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        media: "(min-width: 64rem)",
        onchange: null,
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("renders the product name as branding rather than a document heading", () => {
    render(<AppHeader />);

    expect(screen.getAllByText("Dofek")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Dofek" })).toBeNull();
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
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
    expect(screen.getByLabelText("Mobile").getAttribute("id")).toBe("app-mobile-navigation");
  });

  it("opens mobile navigation as a fixed, scroll-bounded portal with an explicit close action", () => {
    render(<AppHeader />);

    const mobileHeader = screen.getByRole("banner");
    fireEvent.click(screen.getByLabelText("Toggle navigation menu"));

    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(mobileHeader.contains(dialog)).toBe(false);
    expect(dialog.className).toContain("!top-0");
    expect(dialog.className).toContain("max-h-dvh");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(dialog.className).toContain("overscroll-contain");
    expect(within(dialog).getByRole("button", { name: "Close navigation menu" })).toBeTruthy();
  });

  it("moves focus to the first destination, contains Tab focus, and restores the trigger on Escape", async () => {
    render(
      <div>
        <AppHeader />
        <button type="button">Page action</button>
      </div>,
    );

    const menuButton = screen.getByLabelText("Toggle navigation menu");
    menuButton.focus();
    fireEvent.click(menuButton);

    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    const destinations = within(dialog).getAllByRole("link");
    await waitFor(() => expect(document.activeElement).toBe(destinations[0]));

    destinations.at(-1)?.focus();
    fireEvent.keyDown(destinations.at(-1) ?? dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Page action", hidden: true }),
    );

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull());
    expect(document.activeElement).toBe(menuButton);
  });

  it("closes mobile navigation from the visible action, an outside pointer, or a destination", async () => {
    render(<AppHeader />);
    const menuButton = screen.getByLabelText("Toggle navigation menu");

    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("button", { name: "Close navigation menu" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();

    fireEvent.click(menuButton);
    const overlay = document.querySelector("[data-state='open'][aria-hidden='true']");
    if (!(overlay instanceof HTMLElement)) throw new Error("Expected the navigation overlay");
    await waitFor(() => {
      fireEvent.pointerDown(overlay, { button: 1 });
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    });

    fireEvent.click(menuButton);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Navigation" })).getByText("Training"),
    );
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });

  it("closes an open mobile sheet when the viewport crosses the desktop breakpoint", async () => {
    let desktopMatches = false;
    let desktopChangeListener: (() => void) | undefined;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: (_type: string, listener: () => void) => {
          desktopChangeListener = listener;
        },
        get matches() {
          return desktopMatches;
        },
        media: "(min-width: 64rem)",
        onchange: null,
        removeEventListener: vi.fn(),
      })),
    );

    render(<AppHeader />);
    fireEvent.click(screen.getByLabelText("Toggle navigation menu"));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();

    if (!desktopChangeListener) throw new Error("Expected a desktop media-query listener");
    desktopMatches = true;
    act(() => desktopChangeListener?.());

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull());
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Primary navigation")).getByRole("link", {
          name: "Overview",
        }),
      ).toHaveFocus(),
    );
  });

  it("renders primary app destinations and the signed-in user", () => {
    render(<AppHeader />);

    expect(screen.getAllByText("Overview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nutrition").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reports").length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole("navigation", { name: "Sections" }))
        .getByRole("link", { name: "More" })
        .getAttribute("href"),
    ).toBe("/more");

    fireEvent.click(screen.getByLabelText("Toggle navigation menu"));

    expect(
      within(screen.getByRole("navigation", { name: "Mobile" }))
        .getByRole("link", { name: "More" })
        .getAttribute("href"),
    ).toBe("/more");
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
