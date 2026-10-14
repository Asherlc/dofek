export interface GpsCoordinates {
  latitude: number;
  longitude: number;
}

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
