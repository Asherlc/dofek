import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";

const mapCredits = [
  { label: "OpenFreeMap", url: "https://openfreemap.org/" },
  { label: "OpenMapTiles", url: "https://www.openmaptiles.org/" },
  { label: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
];

export const mapAttributionText = mapCredits.map(({ label }) => label).join(" · ");
export const mapAttribution = mapCredits
  .map(({ label, url }) => `<a href="${url}">${label}</a>`)
  .join(" · ");

/** Shared map appearance; activity data is supplied as separate overlays. */
export function createMapStyle(mode: "light" | "dark") {
  const dark = mode === "dark";
  const line = dark ? "#829b88" : "#8b9e85";
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      openmaptiles: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution: mapAttribution,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": dark ? "#1a2a20" : "#e6edde" },
      },
      {
        id: "parks",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "park",
        paint: { "fill-color": dark ? "#213727" : "#dde7d5", "fill-opacity": 0.45 },
      },
      {
        id: "woods",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: ["==", ["get", "class"], "wood"],
        paint: { "fill-color": dark ? "#23392b" : "#dce6d3", "fill-opacity": 0.45 },
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: { "fill-color": dark ? "#29433f" : "#c8dcd4" },
      },
      {
        id: "streams",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        paint: {
          "line-color": dark ? "#456e65" : "#aecbc0",
          "line-width": 1,
          "line-opacity": 0.65,
        },
      },
      {
        id: "roads",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: [
          "!",
          ["in", ["get", "class"], ["literal", ["rail", "transit", "ferry", "path", "track"]]],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": line,
          "line-opacity": 0.72,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 1, 18, 2],
        },
      },
      {
        id: "trails",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": line,
          "line-opacity": 0.8,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 1.3, 19, 2],
        },
      },
    ],
  } satisfies StyleSpecification;
}
