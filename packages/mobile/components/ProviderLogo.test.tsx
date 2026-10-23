import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { ProviderLogo } = await import("./ProviderLogo");

describe("ProviderLogo", () => {
  describe("image logos", () => {
    it("renders an Image for providers with PNG logos", () => {
      const { container } = render(
        <ProviderLogo provider="wahoo" serverUrl="https://example.com" />,
      );
      const img = container.querySelector("Image");
      expect(img).toBeTruthy();
      expect(img?.getAttribute("source")).toBeTruthy();
    });

    it("renders a letter fallback for providers with SVG logos", () => {
      const { container, getByText } = render(
        <ProviderLogo provider="strava" serverUrl="https://example.com" />,
      );
      const img = container.querySelector("Image");
      expect(img).toBeNull();
      expect(getByText("S")).toBeTruthy();
    });

    it("does not render a letter fallback for PNG providers", () => {
      const { queryByText } = render(
        <ProviderLogo provider="wahoo" serverUrl="https://example.com" />,
      );
      // "W" would be the fallback letter — should NOT appear since we have a logo
      expect(queryByText("W")).toBeNull();
    });

    it("uses the default fallback color for SVG provider fallbacks", () => {
      const { queryByText } = render(
        <ProviderLogo provider="strava" serverUrl="https://example.com" />,
      );
      expect(queryByText("S")?.parentElement?.getAttribute("style")).toContain(
        "rgb(107, 138, 107)",
      );
    });

    it("respects the size prop", () => {
      const { container } = render(
        <ProviderLogo provider="wahoo" serverUrl="https://example.com" size={32} />,
      );
      const img = container.querySelector("Image");
      expect(img?.getAttribute("style")).toContain("32");
    });
  });

  describe("letter fallback", () => {
    it("renders a styled letter for providers without a logo", () => {
      const { getByText } = render(
        <ProviderLogo provider="velohero" serverUrl="https://example.com" />,
      );
      expect(getByText("V")).toBeTruthy();
    });

    it("uses the brand color when available", () => {
      const { getByText } = render(
        <ProviderLogo provider="velohero" serverUrl="https://example.com" />,
      );
      const letter = getByText("V");
      expect(letter.parentElement?.getAttribute("style")).toContain("rgb(255, 102, 0)");
    });

    it("shows '?' for an empty string provider", () => {
      const { getByText } = render(<ProviderLogo provider="" serverUrl="https://example.com" />);
      expect(getByText("?")).toBeTruthy();
    });
  });
});

describe("Apple Health source icons", () => {
  it.each(["Strong", "Hang Ten"])("shows %s with an Apple Health badge", (sourceName) => {
    const { container } = render(
      <ProviderLogo
        provider="apple_health"
        sourceName={sourceName}
        size={32}
        serverUrl="https://example.com"
      />,
    );
    const images = container.querySelectorAll("Image");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("style")).toContain("width: 32px");
    expect(images[1]?.getAttribute("style")).toContain("width: 14px");
    expect(images[1]?.getAttribute("style")).toContain("bottom: 0");
    expect(images[1]?.getAttribute("style")).toContain("right: 0");
  });
  it("uses the unknown source initial with the Apple Health badge", () => {
    const { container, getByText } = render(
      <ProviderLogo provider="apple_health" sourceName="New App" serverUrl="https://example.com" />,
    );
    expect(getByText("N")).toBeTruthy();
    expect(container.querySelectorAll("Image")).toHaveLength(1);
  });
});
