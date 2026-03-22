// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageSection } from "./PageSection.tsx";

describe("PageSection", () => {
  it("renders title and children", () => {
    render(
      <PageSection title="Sleep Insights">
        <p>Chart goes here</p>
      </PageSection>,
    );
    expect(screen.getByText("Sleep Insights")).toBeTruthy();
    expect(screen.getByText("Chart goes here")).toBeTruthy();
  });

  it("renders subtitle when provided", () => {
    render(
      <PageSection title="Sleep" subtitle="Stage breakdown over time">
        <p>Content</p>
      </PageSection>,
    );
    expect(screen.getByText("Stage breakdown over time")).toBeTruthy();
  });

  it("wraps children in a card by default", () => {
    const { container } = render(
      <PageSection title="Section">
        <p>Content</p>
      </PageSection>,
    );
    const card = container.querySelector(".card");
    expect(card).toBeTruthy();
  });

  it("does not wrap children in a card when card=false", () => {
    const { container } = render(
      <PageSection title="Section" card={false}>
        <p>Content</p>
      </PageSection>,
    );
    const card = container.querySelector(".card");
    expect(card).toBeFalsy();
  });

  it("uses semantic section element", () => {
    const { container } = render(
      <PageSection title="Section">
        <p>Content</p>
      </PageSection>,
    );
    expect(container.querySelector("section")).toBeTruthy();
  });

  it("uses design token classes not zinc colors", () => {
    const { container } = render(
      <PageSection title="Section" subtitle="Description">
        <p>Content</p>
      </PageSection>,
    );
    const html = container.innerHTML;
    expect(html).not.toContain("zinc");
  });
});
