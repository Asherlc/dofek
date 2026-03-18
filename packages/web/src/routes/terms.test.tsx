import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TermsPage } from "./terms.tsx";

describe("TermsPage", () => {
  it("renders the terms of service page", () => {
    render(<TermsPage />);
    expect(screen.getByText("Terms of Service")).toBeInTheDocument();
  });

  it("includes main sections", () => {
    render(<TermsPage />);
    expect(screen.getByText("1. Acceptance of Terms")).toBeInTheDocument();
    expect(screen.getByText("2. Description of Service")).toBeInTheDocument();
    expect(screen.getByText("3. User Accounts")).toBeInTheDocument();
  });

  it("links to privacy policy", () => {
    render(<TermsPage />);
    const privacyLink = screen.getByText("Privacy Policy");
    expect(privacyLink).toHaveAttribute("href", "/privacy");
  });

  it("has back link to home", () => {
    render(<TermsPage />);
    const backLink = screen.getByText("Back to Dofek");
    expect(backLink).toHaveAttribute("href", "/");
  });
});
