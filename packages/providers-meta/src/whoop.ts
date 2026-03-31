/** WHOOP wear locations — the 5 body sites WHOOP optimizes for. */

export const WHOOP_WEAR_LOCATION_SETTING_KEY = "whoop.wearLocation";

export type WhoopWearLocation = "wrist" | "bicep" | "chest" | "waist" | "calf";

export interface WhoopWearLocationInfo {
  id: WhoopWearLocation;
  label: string;
  description: string;
}

export const WHOOP_WEAR_LOCATIONS: ReadonlyArray<WhoopWearLocationInfo> = [
  {
    id: "wrist",
    label: "Wrist",
    description: "Standard wrist band, ~1 inch above the wrist bone",
  },
  {
    id: "bicep",
    label: "Bicep / Upper Arm",
    description: "Bicep band, arm sleeve, or impact sleeve",
  },
  {
    id: "chest",
    label: "Chest / Torso",
    description: "Sports bra, bralette, or compression top — left side of torso near the heart",
  },
  {
    id: "waist",
    label: "Waist / Waistband",
    description: "Boxers, briefs, shorts, or thong — back waistband near the femoral artery",
  },
  {
    id: "calf",
    label: "Lower Leg / Calf",
    description: "Leggings or speed tights — back of left calf near the popliteal artery",
  },
];

const LOCATION_IDS: ReadonlySet<string> = new Set(
  WHOOP_WEAR_LOCATIONS.map((location) => location.id),
);
const LOCATION_MAP: ReadonlyMap<string, WhoopWearLocationInfo> = new Map(
  WHOOP_WEAR_LOCATIONS.map((location) => [location.id, location]),
);

/** Human-readable label for a wear location, falls back to the raw id. */
export function whoopWearLocationLabel(id: string): string {
  return LOCATION_MAP.get(id)?.label ?? id;
}

/** Short description of what garments go with this wear location. */
export function whoopWearLocationDescription(id: string): string | undefined {
  return LOCATION_MAP.get(id)?.description;
}

function isWhoopWearLocation(value: unknown): value is WhoopWearLocation {
  return typeof value === "string" && LOCATION_IDS.has(value);
}

/** Parse a setting value into a WhoopWearLocation, defaulting to "wrist". */
export function parseWhoopWearLocation(value: unknown): WhoopWearLocation {
  return isWhoopWearLocation(value) ? value : "wrist";
}
