/**
 * OpenStreetMap static tile URL generator.
 *
 * Web Mercator tile coordinates from lat/lng:
 *   x = floor((lng + 180) / 360 * 2^z)
 *   y = floor((1 - ln(tan(latRad) + sec(latRad)) / π) / 2 * 2^z)
 */

const OSM_TILE_HOST = "https://tile.openstreetmap.org";

export interface TileCoord {
  zoom: number;
  tileX: number;
  tileY: number;
}

export function latLngToTile(lat: number, lng: number, zoom: number): TileCoord {
  const tilesPerAxis = 2 ** zoom;
  const tileX = Math.floor(((lng + 180) / 360) * tilesPerAxis);
  const latRad = (lat * Math.PI) / 180;
  const tileY = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * tilesPerAxis,
  );
  return { zoom, tileX, tileY };
}

export function osmTileUrl(lat: number, lng: number, zoom = 13): string {
  const { tileX, tileY, zoom: tileZoom } = latLngToTile(lat, lng, zoom);
  return `${OSM_TILE_HOST}/${tileZoom}/${tileX}/${tileY}.png`;
}
