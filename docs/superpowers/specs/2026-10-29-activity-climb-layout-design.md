# Activity climbing layout

Approved scope carried from the user handoff on 2026-10-29.

- [x] One real MapLibre map for attached climbs and recorded route.
- [x] Desktop: concise list left of map, grouped by the existing area model.
- [x] Narrow web/iOS: map above grouped list, tap selection.
- [x] Row hover/focus highlights a point; row and marker selection stay synchronized.
- [x] Coincident climbs remain individually selectable; missing coordinates retain list entries.
- [x] Preserve exact-climb versus approximate area scope and provider provenance.
- [x] Retain statuses, source links, photos, details and attachment actions.
- [x] Reuse merged subdued green map style and lazy SDK loading.
- [x] Full-layout Storybook preview with actual interaction verification.
- [ ] Tests, lint, typechecks, build, size check, review, pushed branch and new PR; no merge.

## Implementation

Reuse existing area grouping and coordinate grouping. A platform-specific ActivityClimbingPanel owns selection and composes existing climb cards and map. Cards in this panel omit mini-maps. Selection highlights a row; an explicit Details action opens the existing source record modal. Same-day suggestions share the map and appear under Unattached in the grouped list, with their existing pending/error/Attach controls. Query loading/error/empty states remain visible outside the panel.

Add controlled selection/highlight inputs to existing map components without recreating the map on selection. Preserve coordinate groups without jitter or dropping occurrences. Area locations are explicitly approximate. Native uses the same grouping and native MapLibre renderer.

The alternative of rebuilding map rendering or migrating map engines is out of scope. Existing MapLibre marker event and accessible-button behavior are reused ([MapLibre markers](https://maplibre.org/maplibre-gl-js/docs/API/classes/Marker/), [WAI button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)).

## Review and validation record

The fresh code review found that suggestions also needed geographic coverage.
They now share the map and grouped list, with independent Attach state; both
platforms have passing regression tests for suggestion-only sessions. A second
regression verifies that keyboard focus retains its point highlight after the
pointer leaves a row. Selection stays separate from opening Details so the map
remains visible, and numbered map choices distinguish repeated climb names.

Browser verification covered desktop, a 390-pixel viewport with no horizontal
overflow, map/list selection, repeated coordinate choices and suggestions.
The mobile Storybook browser renderer also showed one real map and synchronized
selection. Native iOS export could not run because EXPO_PUBLIC_SENTRY_DSN was
unavailable and both workstation Infisical CLIs lacked a usable login session.
No runtime configuration was changed to bypass that prerequisite.
