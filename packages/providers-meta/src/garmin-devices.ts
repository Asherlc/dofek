import GARMIN_DEVICE_CATALOG from "./garmin-device-catalog.ts";

function normalizeName(name: string): string {
  return name
    .replace(/[®™]/g, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^garmin\s+/, "")
    .replace(/(\d)\s+mm\b/g, "$1mm");
}

function catalogNames(name: string): string[] {
  const group = name.match(/\((\d+\s*mm(?:\s*\/\s*\d+\s*mm)+)\)/i);
  if (!group?.[1]) return [name];
  return [name, ...group[1].split("/").map((size) => name.replace(group[0], size.trim()))];
}

const thumbnails = new Map<string, string | null>();
for (const [names, imageUrl] of GARMIN_DEVICE_CATALOG) {
  for (const name of names.flatMap(catalogNames)) {
    const key = normalizeName(name);
    // Conflicting catalog entries cannot identify a unique product image.
    const existing = thumbnails.get(key);
    thumbnails.set(key, existing === undefined || existing === imageUrl ? imageUrl : null);
  }
}

// Garmin recording names omit AMOLED for these known fēnix 8 sizes.
// Keep these explicit: other variants and unknown sizes must not inherit an image.
for (const [size, catalogSize] of [
  ["43mm", "43mm"],
  ["47mm", "47mm/51mm"],
  ["51mm", "47mm/51mm"],
]) {
  thumbnails.set(
    normalizeName(`fēnix 8 ${size}`),
    thumbnails.get(normalizeName(`fēnix 8 AMOLED (${catalogSize})`)) ?? null,
  );
}

/** Resolve only known Garmin product names; unknown or ambiguous names retain the provider logo. */
export function garminDeviceThumbnail(sourceName: string | null | undefined): string | null {
  return sourceName ? (thumbnails.get(normalizeName(sourceName)) ?? null) : null;
}
