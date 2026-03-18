// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderLogo, providerLabel } from "./ProviderLogo";

afterEach(cleanup);

function queryImg(container: HTMLElement): HTMLImageElement {
  const el = container.querySelector("img");
  if (el === null) throw new Error("Expected an <img> element");
  return el;
}

function querySpan(container: HTMLElement): HTMLSpanElement {
  const el = container.querySelector("span");
  if (el === null) throw new Error("Expected a <span> element");
  return el;
}

describe("providerLabel", () => {
  it("returns the display name for a known provider", () => {
    expect(providerLabel("strava")).toBe("Strava");
    expect(providerLabel("ride-with-gps")).toBe("Ride with GPS");
    expect(providerLabel("whoop")).toBe("WHOOP");
  });

  it("returns the raw id for an unknown provider", () => {
    expect(providerLabel("unknown-provider")).toBe("unknown-provider");
  });
});

describe("ProviderLogo", () => {
  describe("image logos", () => {
    it("renders an SVG img for providers with SVG logos", () => {
      const { container } = render(<ProviderLogo provider="strava" />);
      const img = queryImg(container);
      expect(img.getAttribute("src")).toBe("/logos/strava.svg");
      expect(img.getAttribute("width")).toBe("20");
      expect(img.getAttribute("height")).toBe("20");
    });

    it("renders a PNG img for providers with PNG logos", () => {
      const { container } = render(<ProviderLogo provider="wahoo" />);
      const img = queryImg(container);
      expect(img.getAttribute("src")).toBe("/logos/wahoo.png");
    });

    it("respects the size prop", () => {
      const { container } = render(<ProviderLogo provider="garmin" size={32} />);
      const img = queryImg(container);
      expect(img.getAttribute("width")).toBe("32");
      expect(img.getAttribute("height")).toBe("32");
    });

    it("applies the className prop", () => {
      const { container } = render(<ProviderLogo provider="strava" className="ml-2" />);
      const img = queryImg(container);
      expect(img.className).toContain("ml-2");
    });
  });

  describe("letter fallback", () => {
    it("renders a styled letter for providers without a logo", () => {
      const { container } = render(<ProviderLogo provider="velohero" />);
      const span = querySpan(container);
      expect(span.textContent).toBe("V");
    });

    it("uses the brand color when available", () => {
      const { container } = render(<ProviderLogo provider="velohero" />);
      const span = querySpan(container);
      expect(span.style.backgroundColor).toBe("rgb(255, 102, 0)");
    });

    it("uses the default gray for unknown providers", () => {
      const { container } = render(<ProviderLogo provider="some-new-provider" />);
      const span = querySpan(container);
      expect(span.style.backgroundColor).toBe("rgb(113, 113, 122)");
    });

    it("shows '?' for an empty string provider", () => {
      const { container } = render(<ProviderLogo provider="" />);
      const span = querySpan(container);
      expect(span.textContent).toBe("?");
    });

    it("scales font size to 55% of size", () => {
      const { container } = render(<ProviderLogo provider="velohero" size={40} />);
      const span = querySpan(container);
      expect(span.style.fontSize).toBe("22px");
    });
  });
});
