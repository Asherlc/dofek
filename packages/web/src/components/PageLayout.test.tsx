// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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

  it("renders header children inside the header", () => {
    render(
      <PageLayout headerChildren={<button type="button">Filter</button>}>
        <p>Content</p>
      </PageLayout>,
    );
    expect(screen.getByText("Filter")).toBeTruthy();
  });

  it("renders nav between header and main when provided", () => {
    render(
      <PageLayout nav={<nav data-testid="subnav">Tabs</nav>}>
        <p>Content</p>
      </PageLayout>,
    );
    const subnav = screen.getByTestId("subnav");
    expect(subnav).toBeTruthy();
    // Nav should come before main in DOM order
    const main = screen.getByRole("main");
    expect(subnav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders page intro when title is provided", () => {
    render(
      <PageLayout title="Page Title Here" subtitle="Page description here">
        <p>Content</p>
      </PageLayout>,
    );
    expect(screen.getByText("Page Title Here")).toBeTruthy();
    expect(screen.getByText("Page description here")).toBeTruthy();
  });
});
