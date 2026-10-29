# Shared map style

User approved the subdued, interactive green map preview and the full web/iOS migration on 2026-10-29.

Use one shared light/dark MapLibre style with OpenFreeMap vector tiles. Keep trails, roads, park/woodland fills and waterways quiet; activity overlays remain prominent. Preserve attribution, existing routes, chart hover markers, climbing groups, cluster expansion, attachment controls, loading and actionable error states. Both interactive maps and activity-list previews must match.

Replace Leaflet on web and react-native-maps on mobile, removing their dependencies and obsolete test mocks. MapLibre Native requires an Expo plugin and a new native build ([Expo setup](https://maplibre.org/maplibre-react-native/docs/setup/expo/)). The same style format works across web/native ([OpenFreeMap](https://openfreemap.org/quick_start/)).

The alternatives were retaining current default tiles (cannot reproduce the approved style) or embedding MapLibre inside Leaflet (retains duplicate mapping libraries). The approved full migration uses MapLibre directly.

Keep server-authored projected SVG overlay coordinates for thumbnails. Replace raster tile URLs in the preview contract with a geographic center and zoom, preserving its 1024×576 reference viewport. Clients adjust camera zoom for their rendered size; this is layout, not metric computation. No raster rendering service, new secrets, compatibility bridges or production data migration.

This work changes map rendering throughout the app. The separately approved grouped climbing layout remains a product direction; do not broaden this migration into unrelated activity-detail restructuring.
