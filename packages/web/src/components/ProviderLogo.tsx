/**
 * Brand logos for data providers and identity providers.
 * SVGs from Simple Icons (MIT license), PNGs from Apple App Store / provider websites.
 * Files live in public/logos/ and are served by Vite as static assets.
 */

import {
  BRAND_COLORS,
  PROVIDER_LABELS,
  providerLabel,
  providerLogoType,
} from "@dofek/shared/providers";
export { providerLabel };

interface ProviderLogoProps {
  /** Provider ID (e.g. "strava", "ride-with-gps") */
  provider: string;
  /** Width & height in px (default 20) */
  size?: number;
  className?: string;
}

function logoUrl(provider: string): string | null {
  const type = providerLogoType(provider);
  if (type) return `/logos/${provider}.${type}`;
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
