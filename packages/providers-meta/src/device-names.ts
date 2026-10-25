import APPLE_DEVICE_CATALOG from "./apple-device-catalog.ts";

/** Public Apple hardware identifiers only; unknown/internal identifiers remain unresolved. */
export function appleDeviceModel(identifier: string): string | null {
  return Object.hasOwn(APPLE_DEVICE_CATALOG, identifier)
    ? (APPLE_DEVICE_CATALOG[identifier] ?? null)
    : null;
}

const GARMIN_FAMILIES: Readonly<Record<string, string>> = {
  fr: "Forerunner",
  forerunner: "Forerunner",
  edge: "Edge",
  fenix: "fēnix",
  epix: "epix",
  instinct: "Instinct",
  vivoactive: "vívoactive",
  vivosmart: "vívosmart",
  vivomove: "vívomove",
  venu: "Venu",
  enduro: "Enduro",
  descent: "Descent",
  tactix: "tactix",
  quatix: "quatix",
  approach: "Approach",
};

/** Render supplied model tokens without inferring a size, edition, or capability. */
function garminSymbolName(name: string): string | null {
  // Already-readable names and custom device names retain their spelling and casing.
  if (/[^A-Za-z0-9_]/.test(name)) return null;
  const match = name.match(/^([A-Za-z]+)_?(\d+(?:[sSxX](?=$|_|[A-Z]))?)(.*)$/);
  if (!match) return null;
  const [, family, model, suffix] = match;
  const label =
    family && Object.hasOwn(GARMIN_FAMILIES, family.toLowerCase())
      ? GARMIN_FAMILIES[family.toLowerCase()]
      : undefined;
  if (!label || !model) return null;
  const words = (suffix ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      /^(?:lte|gps|hr|amoled|apac)$/i.test(word)
        ? word.toUpperCase()
        : word[0]?.toUpperCase() + word.slice(1),
    );
  return [label, model.toUpperCase(), ...words].join(" ");
}

/** Shared display-only resolution; raw names and identifiers remain on their source records. */
export function deviceDisplayName(name: string): string {
  const trimmed = name.trim();
  const assioma = trimmed.match(/^assioma_?(uno|duo)$/i);
  if (assioma?.[1]) {
    const variant = assioma[1].toLowerCase();
    return `Assioma ${variant[0]?.toUpperCase()}${variant.slice(1)}`;
  }
  return appleDeviceModel(trimmed) ?? garminSymbolName(trimmed) ?? trimmed;
}
