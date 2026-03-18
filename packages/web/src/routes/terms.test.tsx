// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TermsPage } from "./terms.tsx";

afterEach(cleanup);

describe("TermsPage", () => {
  it("renders without crashing", () => {
    const { container } = render(<TermsPage />);
    expect(container).toBeDefined();
    expect(container.querySelector('h1[class*="font-bold"]')?.textContent).toContain(
      "Terms of Service",
    );
  });

  it("contains main section headings", () => {
    const { container } = render(<TermsPage />);
    const headings = Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);
    expect(headings).toContain("1. Acceptance of Terms");
    expect(headings).toContain("2. Description of Service");
    expect(headings).toContain("3. User Accounts");
  });

  it("has navigation links", () => {
    const { container } = render(<TermsPage />);
    const links = Array.from(container.querySelectorAll("a"));
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/privacy");
    expect(hrefs).toContain("/");
  });
});
