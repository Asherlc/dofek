/**
 * OpenStreetMap static tile URL generator.
 *
 * Web Mercator tile coordinates from lat/lng:
 *   x = floor((lng + 180) / 360 * 2^z)
 *   y = floor((1 - ln(tan(latRad) + sec(latRad)) / π) / 2 * 2^z)
 */

const OSM_TILE_HOST = "https://tile.openstreetmap.org";
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

export interface TileCoord {
  zoom: number;
  tileX: number;
  tileY: number;
}

export function latLngToTile(lat: number, lng: number, zoom: number): TileCoord {
  const tilesPerAxis = 2 ** zoom;
  const maxTileIndex = tilesPerAxis - 1;
  const normalizedLatitude = Math.min(
    Math.max(lat, -WEB_MERCATOR_MAX_LATITUDE),
    WEB_MERCATOR_MAX_LATITUDE,
  );
  const normalizedLongitude = ((((lng + 180) % 360) + 360) % 360) - 180;
  const rawTileX = Math.floor(((normalizedLongitude + 180) / 360) * tilesPerAxis);
  const latRad = (normalizedLatitude * Math.PI) / 180;
  const rawTileY = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * tilesPerAxis,
  );
  const tileX = Math.min(Math.max(rawTileX, 0), maxTileIndex);
  const tileY = Math.min(Math.max(rawTileY, 0), maxTileIndex);
  return { zoom, tileX, tileY };
}

export function osmTileUrl(lat: number, lng: number, zoom = 13): string {
  const { tileX, tileY, zoom: tileZoom } = latLngToTile(lat, lng, zoom);
  return `${OSM_TILE_HOST}/${tileZoom}/${tileX}/${tileY}.png`;
}
