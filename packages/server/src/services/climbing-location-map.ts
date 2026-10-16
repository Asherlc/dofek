import type {
  ClimbingLocationMap,
  ClimbingLocationMapEntry,
  ClimbingLocationMapNode,
} from "@dofek/training/climbing-location-map";
import Supercluster, { type PointFeature } from "supercluster";

interface LocationProperties {
  count: number;
  entries: ClimbingLocationMapEntry[];
}

/** Calculate the complete zoom hierarchy once, keeping metric computation off clients. */
export function buildClimbingLocationMap(
  entries: readonly ClimbingLocationMapEntry[],
): ClimbingLocationMap {
  if (entries.length === 0) return { bounds: null, nodes: [] };

  const locations = new Map<string, PointFeature<LocationProperties>>();
  const bounds = { south: 90, west: 180, north: -90, east: -180 };
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const { latitude, longitude } = entry.location.coordinates;
    bounds.south = Math.min(bounds.south, latitude);
    bounds.north = Math.max(bounds.north, latitude);
    bounds.west = Math.min(bounds.west, longitude);
    bounds.east = Math.max(bounds.east, longitude);
    const key = `${latitude}:${longitude}`;
    const point = locations.get(key);
    if (point) {
      point.properties.count++;
      point.properties.entries.push(entry);
    } else {
      locations.set(key, {
        type: "Feature",
        id: entry.id,
        geometry: { type: "Point", coordinates: [longitude, latitude] },
        properties: { count: 1, entries: [entry] },
      });
    }
  }

  const index = new Supercluster<LocationProperties, { count: number }>({
    maxZoom: 18,
    radius: 48,
    extent: 256,
    map: (properties) => ({ count: properties.count }),
    reduce: (total, properties) => {
      total.count += properties.count;
    },
  }).load([...locations.values()]);

  const nodes = new Map<string, ClimbingLocationMapNode>();
  for (let zoom = 0; zoom <= 19; zoom++) {
    for (const feature of index.getClusters([-180, -90, 180, 90], zoom)) {
      const properties = feature.properties;
      const clusterId = "cluster_id" in properties ? properties.cluster_id : null;
      const id = clusterId === null ? `location:${feature.id}` : `cluster:${clusterId}`;
      const existing = nodes.get(id);
      if (existing) {
        existing.maxZoom = zoom;
        continue;
      }
      const [longitude, latitude] = feature.geometry.coordinates;
      if (longitude === undefined || latitude === undefined)
        throw new Error("Climbing map contains an incomplete location");
      nodes.set(id, {
        id,
        coordinates: { latitude, longitude },
        count: properties.count,
        radius: Math.min(32, 7 * Math.sqrt(properties.count)),
        minZoom: zoom,
        maxZoom: zoom,
        expansionZoom: clusterId === null ? null : index.getClusterExpansionZoom(clusterId),
        entries: "entries" in properties ? properties.entries : [],
      });
    }
  }
  return { bounds, nodes: [...nodes.values()] };
}
