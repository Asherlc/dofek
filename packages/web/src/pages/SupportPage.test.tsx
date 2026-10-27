/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupportPage } from "./SupportPage.tsx";

const mockUseAuth = vi.fn();

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("../components/SupportPanel.tsx", () => ({
  SupportPanel: () => <div>secure support form</div>,
}));

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: () => mockUseAuth(),
}));

describe("SupportPage", () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: null });
  });

  afterEach(() => {
    cleanup();
    mockUseAuth.mockReset();
  });

  it("gives signed-out visitors a path to request support", () => {
    render(<SupportPage />);

    expect(screen.getByRole("link", { name: "Sign in to contact support" })).toHaveAttribute(
      "href",
      "/login?returnTo=/support",
    );
    expect(screen.queryByText("secure support form")).toBeNull();
  });

  it("shows the secure form to signed-in visitors", () => {
    mockUseAuth.mockReturnValue({ user: { id: "user-1" } });

    render(<SupportPage />);

    expect(screen.getByText("secure support form")).toBeTruthy();
  });
});
