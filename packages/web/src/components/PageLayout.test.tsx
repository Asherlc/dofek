// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageLayout } from "./PageLayout.tsx";

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: () => ({ user: null, isLoading: false, logout: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={props.to}>{children}</a>
  ),
}));

describe("PageLayout", () => {
  it("renders children inside a main element", () => {
    render(
      <PageLayout>
        <p>Page content</p>
      </PageLayout>,
    );
    const main = screen.getByRole("main");
    expect(main).toBeTruthy();
    expect(screen.getByText("Page content")).toBeTruthy();
  });

  it("applies new design tokens (bg-page, text-foreground)", () => {
    const { container } = render(
      <PageLayout>
        <p>Content</p>
      </PageLayout>,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper).toBeTruthy();
    expect(wrapper instanceof HTMLElement).toBe(true);
    if (wrapper instanceof HTMLElement) {
      expect(wrapper.className).toContain("bg-page");
      expect(wrapper.className).toContain("text-foreground");
      // Must NOT contain old zinc-based dark classes
      expect(wrapper.className).not.toContain("bg-zinc");
      expect(wrapper.className).not.toContain("text-zinc");
    }
  });

  it("uses the desktop evidence-desk shell layout", () => {
    const { container } = render(
      <PageLayout>
        <p>Content</p>
      </PageLayout>,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper).toBeTruthy();
    expect(wrapper instanceof HTMLElement).toBe(true);
    if (wrapper instanceof HTMLElement) {
      expect(wrapper.className).toContain("lg:flex");
    }

    const contentShell = screen.getByRole("main").parentElement;
    expect(contentShell).toBeTruthy();
    expect(contentShell instanceof HTMLElement).toBe(true);
    if (contentShell instanceof HTMLElement) {
      expect(contentShell.className).toContain("lg:min-w-0");
      expect(contentShell.className).toContain("lg:flex-1");
    }
  });

  it("renders header controls once in the content toolbar", () => {
    render(
      <PageLayout headerChildren={<button type="button">Filter</button>}>
        <p>Content</p>
      </PageLayout>,
    );
    expect(screen.getAllByText("Filter")).toHaveLength(1);
  });

  it("renders tabs between header and main when provided", () => {
    const tabs = [
      { to: "/foo", label: "Foo", exact: true },
      { to: "/bar", label: "Bar", exact: false },
    ];
    render(
      <PageLayout tabs={tabs}>
        <p>Content</p>
      </PageLayout>,
    );
    const fooLink = screen.getByText("Foo");
    const barLink = screen.getByText("Bar");
    expect(fooLink).toBeTruthy();
    expect(barLink).toBeTruthy();
    // Tab nav should come before main in DOM order
    const tabNav = fooLink.closest("nav");
    expect(tabNav).toBeTruthy();
    expect(tabNav instanceof HTMLElement).toBe(true);
    if (tabNav instanceof HTMLElement) {
      expect(tabNav.getAttribute("aria-label")).toBe("Section navigation");
      const main = screen.getByRole("main");
      expect(tabNav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("labels the tab navigation so tests and assistive tech can target visible tabs", () => {
    const tabs = [{ to: "/foo", label: "Foo", exact: true }];
    render(
      <PageLayout tabs={tabs}>
        <p>Content</p>
      </PageLayout>,
    );
    expect(screen.getByRole("navigation", { name: "Section navigation" })).toBeTruthy();
  });

  it("wraps secondary navigation", () => {
    const tabs = [
      { to: "/training", label: "Overview", exact: true },
      { to: "/training/endurance", label: "Endurance", exact: false },
      { to: "/training/cycling", label: "Cycling", exact: false },
      { to: "/training/running", label: "Running", exact: false },
      { to: "/training/strength", label: "Strength", exact: false },
      { to: "/training/hiking", label: "Hiking", exact: false },
      { to: "/training/climbing", label: "Climbing", exact: false },
      { to: "/training/recovery", label: "Recovery", exact: false },
    ];
    render(
      <PageLayout tabs={tabs}>
        <p>Content</p>
      </PageLayout>,
    );

    const tabList = screen.getByRole("list", { name: "Section links" });
    expect(tabList).toHaveClass("flex-wrap");
  });

  it("keeps every secondary destination as a keyboard-focusable link", () => {
    const tabs = [
      { to: "/training", label: "Overview", exact: true },
      { to: "/training/recovery", label: "Recovery", exact: false },
    ];
    render(
      <PageLayout tabs={tabs}>
        <p>Content</p>
      </PageLayout>,
    );

    const navigation = screen.getByRole("navigation", { name: "Section navigation" });
    const links = within(navigation).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Overview", "Recovery"]);
    for (const link of links) {
      expect(link.getAttribute("tabindex")).not.toBe("-1");
    }
  });

  it("renders page intro when title is provided", () => {
    render(
      <PageLayout title="Page Title Here" subtitle="Page description here">
        <p>Content</p>
      </PageLayout>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Page Title Here" })).toBeTruthy();
    expect(screen.getByText("Page description here")).toBeTruthy();
  });
});
