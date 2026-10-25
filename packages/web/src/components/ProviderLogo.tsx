/**
 * Brand logos for data providers and identity providers.
 * SVGs from Simple Icons (MIT license), PNGs from Apple App Store / provider websites.
 * Files live in public/logos/ and are served by Vite as static assets.
 */

import {
  BRAND_COLORS,
  PROVIDER_LABELS,
  providerLabel,
  providerLogoId,
  providerLogoType,
  providerSourceLogo,
} from "@dofek/providers/providers";

export { providerLabel };

interface ProviderLogoProps {
  /** Provider ID (e.g. "strava", "ride-with-gps") */
  provider: string;
  sourceName?: string | null;
  /** Width & height in px (default 20) */
  size?: number;
  className?: string;
}

function logoUrl(provider: string): string | null {
  const type = providerLogoType(provider);
  if (type) return `/logos/${providerLogoId(provider)}.${type}`;
  return null;
}

export function ProviderLogo({
  provider,
  sourceName,
  size = 20,
  className = "",
}: ProviderLogoProps) {
  const source = providerSourceLogo(provider, sourceName);
  if (source.viaAppleHealth) {
    const badgeSize = Math.round(size * 0.45);
    return (
      <span
        className={`relative inline-flex shrink-0 ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <ProviderLogo provider={source.provider} size={size} />
        <img
          src="/logos/apple_health.png"
          alt=""
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            width: badgeSize,
            height: badgeSize,
            borderRadius: badgeSize * 0.2,
          }}
        />
      </span>
    );
  }
  provider = source.provider;
  const url = logoUrl(provider);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ borderRadius: size * 0.2 }}
        className={`shrink-0 ${className}`}
        aria-hidden="true"
      />
    );
  }

  // Styled letter fallback for providers without a logo file
  const label = PROVIDER_LABELS[provider] ?? provider;
  const letter = label[0]?.toUpperCase() ?? "?";
  const color = BRAND_COLORS[provider] ?? "#6b8a6b";
  const fontSize = Math.round(size * 0.55);

  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.2,
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
