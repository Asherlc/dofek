/**
 * Brand logos for data providers and identity providers.
 * SVGs from Simple Icons (MIT license), PNGs from Apple App Store / provider websites.
 * Files live in public/logos/ and are served by Vite as static assets.
 */

import { PROVIDER_LABELS, providerLabel } from "@dofek/shared/providers";
export { providerLabel };

interface ProviderLogoProps {
  /** Provider ID (e.g. "strava", "ride-with-gps") */
  provider: string;
  /** Width & height in px (default 20) */
  size?: number;
  className?: string;
}

// Providers that have an SVG logo file (Simple Icons)
const SVG_LOGOS = new Set([
  "strava",
  "garmin",
  "fitbit",
  "google",
  "apple",
  "peloton",
  "trainerroad",
  "komoot",
  "eight-sleep",
  "authentik",
]);

// Providers that have a PNG logo file (App Store icons / provider websites)
const PNG_LOGOS = new Set([
  "polar",
  "zwift",
  "suunto",
  "wahoo",
  "whoop",
  "oura",
  "withings",
  "decathlon",
  "coros",
  "concept2",
  "ride-with-gps",
  "mapmyfitness",
  "fatsecret",
  "xert",
  "ultrahuman",
  "wger",
  "strong-csv",
  "cronometer-csv",
  "cycling_analytics",
  "apple-health",
]);

// Brand colors used for the styled-letter fallback
const BRAND_COLORS: Record<string, string> = {
  velohero: "#FF6600",
  bodyspec: "#00B4D8",
};

function logoUrl(provider: string): string | null {
  if (SVG_LOGOS.has(provider)) return `/logos/${provider}.svg`;
  if (PNG_LOGOS.has(provider)) return `/logos/${provider}.png`;
  return null;
}

export function ProviderLogo({ provider, size = 20, className = "" }: ProviderLogoProps) {
  const url = logoUrl(provider);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className={`shrink-0 ${className}`}
        aria-hidden="true"
      />
    );
  }

  // Styled letter fallback for providers without a logo file
  const label = PROVIDER_LABELS[provider] ?? provider;
  const letter = label[0]?.toUpperCase() ?? "?";
  const color = BRAND_COLORS[provider] ?? "#71717a";
  const fontSize = Math.round(size * 0.55);

  return (
    <span
      className={`inline-flex items-center justify-center rounded shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        color: "#fff",
        fontSize,
        fontWeight: 600,
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
