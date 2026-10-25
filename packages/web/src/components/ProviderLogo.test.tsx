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
    expect(providerLabel("whoop")).toBe("WHOOP (Cloud)");
    expect(providerLabel("whoop_ble")).toBe("WHOOP (Bluetooth)");
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

    it("renders WHOOP Bluetooth with the shared WHOOP logo asset", () => {
      const { container } = render(<ProviderLogo provider="whoop_ble" />);
      const img = queryImg(container);
      expect(img.getAttribute("src")).toBe("/logos/whoop.png");
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
      const { container } = render(<ProviderLogo provider="mountain-project" />);
      const span = querySpan(container);
      expect(span.textContent).toBe("M");
    });

    it("uses the brand color when available", () => {
      const { container } = render(<ProviderLogo provider="mountain-project" />);
      const span = querySpan(container);
      expect(span.style.backgroundColor).toBe("rgb(31, 90, 136)");
    });

    it("uses the default gray for unknown providers", () => {
      const { container } = render(<ProviderLogo provider="some-new-provider" />);
      const span = querySpan(container);
      expect(span.style.backgroundColor).toBe("rgb(107, 138, 107)");
    });

    it("shows '?' for an empty string provider", () => {
      const { container } = render(<ProviderLogo provider="" />);
      const span = querySpan(container);
      expect(span.textContent).toBe("?");
    });

    it("scales font size to 55% of size", () => {
      const { container } = render(<ProviderLogo provider="mountain-project" size={40} />);
      const span = querySpan(container);
      expect(span.style.fontSize).toBe("22px");
    });
  });
});

describe("Apple Health source icons", () => {
  it("renders the personalized Apple Watch source with its Apple Health badge", () => {
    const { container } = render(
      <ProviderLogo provider="apple_health" sourceName={"Asher’s Apple\u00a0Watch"} size={32} />,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe("/logos/apple-watch.svg");
    expect(images[0]?.getAttribute("width")).toBe("32");
    expect(images[1]?.getAttribute("src")).toBe("/logos/apple_health.png");
    expect(images[1]?.getAttribute("style")).toContain("width: 14px");
  });

  it.each([
    ["Strong", "strong-csv"],
    ["Hang Ten", "hang-ten"],
  ])("shows %s with an Apple Health badge", (sourceName, asset) => {
    const { container } = render(
      <ProviderLogo provider="apple_health" sourceName={sourceName} size={32} />,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toContain(`${asset}.png`);
    expect(images[1]?.getAttribute("src")).toContain("apple_health.png");
    expect(images[1]?.getAttribute("style")).toContain("bottom: 0");
    expect(images[1]?.getAttribute("style")).toContain("right: 0");
  });
  it("uses the unknown source initial with the Apple Health badge", () => {
    const { container, getByText } = render(
      <ProviderLogo provider="apple_health" sourceName="New App" />,
    );
    expect(getByText("N")).toBeTruthy();
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});
