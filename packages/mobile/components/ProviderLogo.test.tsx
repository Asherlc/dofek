import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));

const { ProviderLogo } = await import("./ProviderLogo");

describe("ProviderLogo", () => {
  describe("Garmin recording devices", () => {
    it("shows a contained model thumbnail at the requested size", () => {
      const { container } = render(
        <ProviderLogo
          provider="garmin"
          sourceName="Forerunner 965"
          size={32}
          serverUrl="https://example.com"
        />,
      );
      const img = container.querySelector("Image");
      expect(img).toBeTruthy();
      expect(img?.getAttribute("resizeMode")).toBe("contain");
      expect(img?.getAttribute("style")).toContain("width: 32px");
      expect(img?.getAttribute("style")).toContain("height: 32px");
    });

    it.each([undefined, "Unrecognized watch", "Forerunner 965 Ultra"])(
      "keeps the provider logo for %s",
      (sourceName) => {
        const { container } = render(
          <ProviderLogo
            provider="garmin"
            sourceName={sourceName}
            serverUrl="https://example.com"
          />,
        );
        expect(container.querySelector("SvgUri")?.getAttribute("uri")).toBe(
          "https://example.com/logos/garmin.svg",
        );
      },
    );

    it("keeps another provider's logo when its source names a Garmin model", () => {
      const { container } = render(
        <ProviderLogo provider="strava" sourceName="Edge 1050" serverUrl="https://example.com" />,
      );
      expect(container.querySelector("SvgUri")?.getAttribute("uri")).toBe(
        "https://example.com/logos/strava.svg",
      );
    });

    it("reports a failed thumbnail and falls back to Garmin until the image URL changes", () => {
      const { container, rerender } = render(
        <ProviderLogo
          provider="garmin"
          sourceName="Forerunner 965"
          serverUrl="https://example.com"
        />,
      );
      const image = container.querySelector("Image");
      if (!image) throw new Error("Expected a model thumbnail");
      fireEvent.error(image);
      expect(container.querySelector("SvgUri")?.getAttribute("uri")).toBe(
        "https://example.com/logos/garmin.svg",
      );
      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ provider: "garmin", sourceName: "Forerunner 965" }),
      );
      rerender(
        <ProviderLogo
          provider="garmin"
          sourceName="Garmin Forerunner® 965"
          serverUrl="https://example.com"
        />,
      );
      expect(container.querySelector("SvgUri")?.getAttribute("uri")).toBe(
        "https://example.com/logos/garmin.svg",
      );
      rerender(
        <ProviderLogo provider="garmin" sourceName="Edge 1050" serverUrl="https://example.com" />,
      );
      expect(container.querySelector("Image")).toBeTruthy();
    });
  });

  describe("image logos", () => {
    it("renders an Image for providers with PNG logos", () => {
      const { container } = render(
        <ProviderLogo provider="wahoo" serverUrl="https://example.com" />,
      );
      const img = container.querySelector("Image");
      expect(img).toBeTruthy();
      expect(img?.getAttribute("source")).toBeTruthy();
    });

    it("renders the SVG asset for providers with SVG logos", () => {
      const { container } = render(
        <ProviderLogo provider="strava" serverUrl="https://example.com" />,
      );
      const img = container.querySelector("Image");
      expect(img).toBeNull();
      expect(container.querySelector("SvgUri")?.getAttribute("uri")).toBe(
        "https://example.com/logos/strava.svg",
      );
    });

    it("does not render a letter fallback for PNG providers", () => {
      const { queryByText } = render(
        <ProviderLogo provider="wahoo" serverUrl="https://example.com" />,
      );
      // "W" would be the fallback letter — should NOT appear since we have a logo
      expect(queryByText("W")).toBeNull();
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
        <ProviderLogo provider="mountain-project" serverUrl="https://example.com" />,
      );
      expect(getByText("M")).toBeTruthy();
    });

    it("uses the brand color when available", () => {
      const { getByText } = render(
        <ProviderLogo provider="mountain-project" serverUrl="https://example.com" />,
      );
      const letter = getByText("M");
      expect(letter.parentElement?.getAttribute("style")).toContain("rgb(31, 90, 136)");
    });

    it("shows '?' for an empty string provider", () => {
      const { getByText } = render(<ProviderLogo provider="" serverUrl="https://example.com" />);
      expect(getByText("?")).toBeTruthy();
    });
  });
});

describe("Apple Health source icons", () => {
  it("renders the personalized Apple Watch source with its Apple Health badge", () => {
    const { container } = render(
      <ProviderLogo
        provider="apple_health"
        sourceName={"Asher’s Apple\u00a0Watch"}
        size={32}
        serverUrl="https://example.com"
      />,
    );
    const watch = container.querySelector("SvgUri");
    expect(watch?.getAttribute("uri")).toBe("https://example.com/logos/apple-watch.svg");
    expect(watch?.getAttribute("width")).toBe("32");
    const images = container.querySelectorAll("Image");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("style")).toContain("width: 14px");
  });

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

it("renders a known SVG source with an Apple Health badge", () => {
  const { container } = render(
    <ProviderLogo provider="apple_health" sourceName="Strava" serverUrl="https://example.com" />,
  );
  expect(container.querySelector("SvgUri")?.getAttribute("uri")).toBe(
    "https://example.com/logos/strava.svg",
  );
  expect(container.querySelectorAll("Image")).toHaveLength(1);
});
