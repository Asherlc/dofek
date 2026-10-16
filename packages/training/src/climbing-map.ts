import type { GpsCoordinates } from "./gps-coordinates.ts";

export interface ClimbingMapLocation {
  coordinates: GpsCoordinates;
  scope: "climb" | "area";
  objectId: string;
  providerId: string;
  name: string | null;
}

export interface ClimbingMapMarker {
  entryId: string;
  /** Position in the full card list, including entries without coordinates. */
  entryNumber?: number;
  label: string;
  location: ClimbingMapLocation;
}

interface ClimbingMapEntry {
  id: string;
  climb: { name: string | null } | null;
  title: string | null;
  mapLocation: ClimbingMapLocation | null;
}

export function buildClimbingMapLocations(
  entries: readonly ClimbingMapEntry[],
): Record<string, ClimbingMapLocation> {
  return Object.fromEntries(
    entries.flatMap((entry) => (entry.mapLocation ? [[entry.id, entry.mapLocation] as const] : [])),
  );
}

export function buildClimbingMapMarkers(entries: readonly ClimbingMapEntry[]): ClimbingMapMarker[] {
  return entries.flatMap((entry, index) =>
    entry.mapLocation
      ? [
          {
            entryId: entry.id,
            entryNumber: index + 1,
            label: entry.climb?.name ?? entry.title ?? "Climbing log",
            location: entry.mapLocation,
          },
        ]
      : [],
  );
}
