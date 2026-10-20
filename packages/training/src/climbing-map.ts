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

interface ClimbingMapMarkerGroup {
  coordinates: GpsCoordinates;
  markers: [ClimbingMapMarker, ...ClimbingMapMarker[]];
  title: string;
  description: string;
}

/** Group coincident UI markers without moving source coordinates or discarding logs. */
export function groupClimbingMapMarkers(
  markers: readonly ClimbingMapMarker[],
  providerLabel: (providerId: string) => string,
): ClimbingMapMarkerGroup[] {
  const groups = new Map<string, [ClimbingMapMarker, ...ClimbingMapMarker[]]>();
  for (const marker of markers) {
    const { latitude, longitude } = marker.location.coordinates;
    const key = `${latitude}:${longitude}`;
    const group = groups.get(key);
    if (group) group.push(marker);
    else groups.set(key, [marker]);
  }
  return [...groups.values()].map((markers) => ({
    coordinates: markers[0].location.coordinates,
    markers,
    title: `${markers.length > 1 ? `${markers.length} climbs · ` : ""}${markers.map((marker) => marker.label).join(" · ")}`,
    description: [
      ...new Set(
        markers.map(
          ({ location }) =>
            `${location.scope === "area" ? "Area location" : "Climb location"}: ${location.name ?? location.objectId} · ${providerLabel(location.providerId)}`,
        ),
      ),
    ].join(" · "),
  }));
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
