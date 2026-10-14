import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation, ClimbingMapMarker } from "@dofek/training/climbing-map";
import { type ReactNode, useMemo } from "react";
import { ActivityRouteMap } from "../../../components/ActivityRouteMap.tsx";

const NO_SENSOR_POINTS: Array<{ lat: number; lng: number }> = [];

export function ClimbingEntryCard({
  entryId,
  name,
  location,
  children,
  entryNumber,
  selected = false,
}: {
  entryId: string;
  name: string;
  location: ClimbingMapLocation | undefined;
  children: ReactNode;
  entryNumber?: number;
  selected?: boolean;
}) {
  const markers = useMemo<ClimbingMapMarker[]>(
    () => (location ? [{ entryId, entryNumber, label: name, location }] : []),
    [entryId, entryNumber, name, location],
  );
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border p-3 ${selected ? "border-accent" : "border-border"}`}
    >
      {entryNumber != null && (
        <p className="text-xs text-subtle">
          Entry {entryNumber}
          {selected ? " · Selected" : ""}
        </p>
      )}
      {location && (
        <>
          <ActivityRouteMap
            points={NO_SENSOR_POINTS}
            climbMarkers={markers}
            presentation="compact"
          />
          <p className="break-words text-xs text-subtle">
            {location.scope === "area" ? "Area location" : "Climb location"}:{" "}
            {location.name ?? location.objectId} · {providerSourceLabel(location.providerId)}
          </p>
        </>
      )}
      {children}
    </li>
  );
}
