# Dofek Web

The web dashboard for Dofek. A modern React SPA built with Vite, TypeScript, and Tailwind CSS.

## Architecture

- **React + TypeScript**: Functional components with hooks.
- **TanStack Router**: Type-safe routing defined in `src/routes/` and generated in `src/routeTree.gen.ts`.
- **tRPC + TanStack Query**: Data fetching layer (`src/lib/trpc.ts`) with built-in caching and invalidation.
- **Storybook**: Component library development and documentation (`.stories.tsx` files).
- **PostHog**: Product analytics and session recording.

## Key Implementation Details

- **tRPC Client**: Configured with `httpBatchStreamLink` in `src/lib/trpc.ts` to support streamed responses from the server. Automatically redirects to `/login` on 401 errors.
- **Layout Management**: Uses `DashboardLayoutProvider` to manage dashboard widget placement and persistent grid states.
- **Admin tables**: Use TanStack Table v9's `useTable` with core features and render all rows in each server-provided page. Keep pagination in the admin query, following the [v9 migration guide](https://tanstack.com/table/latest/docs/framework/react/guide/migrating).
- **Nutrition history**: The Nutrition page renders read-only nutrition history, totals, source resolution, and analytics.
- **Unit System**: A global `UnitProvider` handles conversion between metric and imperial units across the application.
- **Charts**: Custom visualization components (e.g., `TimeSeriesChart`, `PmcChart`, `Hypnogram`) built on top of ECharts and `react-native-svg` (shared patterns).
- **Resting heart rate trend**: The dashboard renders the server's trailing seven-calendar-day average as a line without visible point markers. The card and hover labels identify the average; daily readings remain on the heart-rate detail page. See [`Dashboard`](src/pages/Dashboard.tsx) and the [server window calculation](../server/src/repositories/daily-metrics-repository.ts).
- **Climbing progression**: One grade-colored stack per period combines all types and settings selected in the page filters. The [server projection](../server/src/repositories/climbing-grade-progression.ts) counts distinct recorded climbing dates across that selection before calculating sends per day, so a mixed climbing day counts once. Grades follow the [saved display preferences](../server/src/repositories/climbing-repository.ts); the [shared contract and labels](../training/src/climbing-progression.ts) keep boulder, route, and retained source scales distinct and qualify label collisions. Both clients render the supplied totals, rates, and stack bounds. See [`ClimbingGradeProgressionChart`](src/components/ClimbingGradeProgressionChart.tsx).
- **Climbing strengths**: The climbing page shows a compact type/setting summary and one Filters popover above all charts. Every filter uses independent checkboxes; each All checkbox selects or clears its group and exposes a mixed state for a partial selection, following the [WAI checkbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/). Type includes Bouldering, Lead, Top rope, Follow, and Unroped; overlapping kind/method selectors and the broader Discipline selector are omitted. Attempt scope, Solo status, Protection used, and Route protection stay under More filters with the same checkboxes. Choices match any selected value within a group and intersect across groups, as implemented by the [shared server projection](../server/src/repositories/climbing-rock-observations.ts). Whole climb remains the default scope; selecting both scopes explicitly includes pitch observations. Its [strengths section](src/components/ClimbingStrengths.tsx) has one fixed visualization per tab: Styles uses a grade-adjusted radar, Grades uses the grade/style heatmap, and Progress uses one monthly send-rate chart. Wall angle and Hold type apply to every tab; there is no grade picker or format menu. The strengths views combine the types selected in Filters into one chart per tab; the server retains type-specific grade baselines and qualifies grade labels when multiple contexts are selected. The radar compares observed sends with expected sends from the same-grade baseline, computed by the [server](../server/src/services/climbing-strength-profile.ts). Zero on the radar is the usual same-grade result; outside the dashed baseline is stronger and inside weaker. Progress explicitly combines grades, so its changes can reflect difficulty mix. Point and exact-value selection retain source-climb details; climbing contexts, zeros, missing data and unknown results stay distinct. Values come from the [shared server-computed contract](../training/src/climbing-strengths.ts). See the [data exploration guidance](../../docs/data-exploration.md) for the research and interaction rules, including [ONS guidance](https://service-manual.ons.gov.uk/data-visualisation/guidance/interactive-charts-and-animations).
- **Climbing locations**: The training page renders server-sized circles that split into smaller groups and individual climb locations as the map zooms in. Selecting a location lists its recorded climbs, source-location scope, and attached activities. The [shared response contract](../training/src/climbing-location-map.ts) supplies the zoom bands, counts, and radii; [ClimbingLocationMap](src/components/ClimbingLocationMap.tsx) renders them with [Leaflet circle markers](https://leafletjs.com/reference.html#circlemarker).
  Unattached logs offer **Attach to activity**, which opens the
  [activity picker](src/components/ClimbingLogAttachment.tsx) for that log's
  date. It lists eligible same-day activities with source and local start
  time, preserves the source date, and refreshes the affected queries after
  attachment. Loading, lookup errors, attachment errors, and no eligible
  activity are distinct states. The picker reuses the
  [modal dialog](src/components/ModalDialog.tsx), following the
  [WAI modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
- **Error Boundaries**: Granular error handling using `QueryErrorBoundary` and a top-level `ErrorBoundary` in `App.tsx`.


## Offline behavior

Production builds precache the application shell and hashed static assets with
`vite-plugin-pwa` and Workbox. The service worker does not cache API, auth, or
callback responses. This follows the plugin's
[generated service worker](https://vite-pwa-org.netlify.app/workbox/generate-sw.html)
model without adding runtime caching for health data.

Already-rendered query data remains in memory for five minutes after a route
unmounts, so route-away/back navigation can render the last available value
while TanStack Query checks for fresher data. TanStack documents this
stale-while-revalidate cache lifecycle in its
[caching guide](https://tanstack.com/query/latest/docs/framework/react/guides/caching).
The cache is intentionally not persisted to browser storage and is cleared
when the authenticated user changes.

## Development

Activity details show attached climbing logs and same-day attachment suggestions
for climbing activities. Cards group under Area headings and show the
published display grade, concise attempt counts, pitch labels, and server-derived
rock labels through the [shared grouping helper](../training/src/climbing-log-groups.ts)
and [card](src/pages/activity-detail/components/ClimbingLogEntryCard.tsx).
Areas flow as blocks, with singleton areas sharing a row and larger areas
wrapping their cards internally. The
[breakdown](src/pages/activity-detail/components/ClimbingLogEntryBreakdown.tsx)
uses [ResizeObserver](https://www.w3.org/TR/resize-observer/) to keep each block's
column span within the available grid and preserve consistent card widths.
The provider data viewer's
[record details](src/components/ClimbingLogEntryDetails.tsx) show source links,
published and reported grade collections, known attempt facts, and notes.
Coordinates, internal references, and raw provider payloads are omitted from this
viewer. Missing totals retain one recorded occurrence. Provider
records fetch the selected log's complete graph and retain cached rows during
refresh errors. See the [canonical response contract](../server/src/contracts/climbing-log-contracts.ts).


The recent climbing activity table omits distance and keeps its climbing metrics,
as configured by the [climbing page](src/routes/training/climbing.tsx).

Activity-list cards use the stored cycling modality to show training stats instead
of distance and elevation for indoor and virtual rides, including reported zeros.
See [the card](src/components/ActivityCardContent.tsx) and the
[shared cycling classification](../training/src/endurance-types.ts).

The [activity detail header](src/pages/ActivityDetailPage.tsx) also omits distance
for indoor and virtual cycling. Rides show **Energy Output** in kJ from the
server's full recorded power samples, following the selected power source.
Incomplete coverage carries a **Partial power data** qualifier. This is mechanical
work: a watt is a joule per second ([NIST](https://www.nist.gov/glossary-term/34606)).
The [server query](../server/src/routers/activity.ts) reuses the
[cycling workout calculation](../training/src/cycling-workout-metrics.ts).

The [Activities cards](src/components/ActivityCardContent.tsx) show an inset map
panel beside activity details on wider screens and below them on narrow screens.
The [mobile Activities list](<../mobile/app/(tabs)/activities.tsx>) shows the same
server-projected preview in a full-width 16:9 panel below each activity's details.
The [map tile](src/components/ActivityMapTile.tsx) also displays climbing-source
locations when an activity has no recorded GPS track. Source points retain
Climb/Area and provider attribution; they are not connected into a route and do
not imply recorded distance or elevation. The
[calendar repository](../server/src/repositories/activities-calendar-repository.ts)
projects map geometry on the server, and recorded GPS takes precedence.

Cards without a map show one downloaded activity image when available; processing
maps keep their panel. The activity detail's
[Photos gallery](src/components/ActivityPhotos.tsx) opens images with captions and
source attribution in the existing accessible modal, following the
[WAI dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
The [shared query policy](../training/src/activity-images.ts) renews private signed
links; see [activity image storage and display](../../docs/activity-images.md).

Expected maps retain their space and show a processing status while location data
or initial map tiles are pending. List queries refresh while the server reports a
pending map, and ready maps remain visible during background refreshes. The shared
[map tile](src/components/ActivityMapTile.tsx) and
[route map](src/components/ActivityRouteMap.tsx), and training
[location map](src/components/ClimbingLocationMap.tsx) expose the status to assistive
technology using the [WAI status-message pattern](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22.html).
Interactive-map initialization waits for Leaflet's initial tile
[`load` event](https://leafletjs.com/reference.html#gridlayer-load); tile errors
retain their connection message and usable route/source points.

Activity-detail climbing logs and attachment suggestions share the
[canonical log-card grid](src/pages/activity-detail/components/ClimbingLogEntryBreakdown.tsx).
Their component inputs accept source locations keyed by entry ID; the
[shared location types](../training/src/climbing-map.ts) retain coordinates,
the owning Climb or Area, and provider attribution.
[ActivityRouteMap](src/components/ActivityRouteMap.tsx) renders source dots
independently of recorded GPS tracks and loads compact tick maps as they
approach the viewport. A unique point opens its climbing log details immediately;
coincident locations show a counted marker. Its tooltip lists every climb name and
source-location label. Selecting that marker offers each log by climb name, including repeated names,
without an entry-number heading. The [shared marker grouping](../training/src/climbing-map.ts)
preserves source coordinates and log identities; the web count uses a
[Leaflet DivIcon](https://leafletjs.com/reference.html#divicon).
Selection opens the exact log's
[record dialog](src/pages/RecordDetailModal.tsx) and highlights its
[climbing card](src/pages/activity-detail/components/ClimbingLogEntryCard.tsx),
including repeated names at the same point. Closing the dialog returns keyboard
focus to its triggering map point or occurrence button; the [activity tests](src/pages/ActivityDetailPage.test.tsx)
cover closing and reopening the same occurrence.
The activity screen supplies each log's server-projected location to the
overview and compact maps, including when no recorded GPS route exists.
The [server projection](../server/src/repositories/climbing-activity-log-entry-repository.ts)
uses a source Climb point or its nearest containing Area with coordinates;
labels identify the owning source and distinguish Area from Climb locations.
Unattached suggestions show their own compact source-location maps. The
colocated map and climbing-log Storybook stories exercise these component inputs.

```bash
cd packages/web && pnpm dev      # Start Vite dev server (proxies /api to server)
cd packages/web && pnpm build    # Build for production (outputs to dist/)
cd packages/web && pnpm storybook # Start Storybook
pnpm test                        # Run repo-wide Vitest suites from the repo root
```

Activity cards lead with the shared rounded-outline activity icon. A source row
below the content and map expands inside the same card to show propagation
branches. The row shows the recording source once and serves as the root when
expanded. Separate copies from the same provider remain distinct, while
unconnected records appear as other matching sources. Dofek remains implicit.
See [ActivityCardContent](src/components/ActivityCardContent.tsx) and
[ActivitySourceDisclosure](src/components/ActivitySourceDisclosure.tsx).

The [activity detail header](src/pages/ActivityDetailPage.tsx) uses the same
disclosure in place of flat source links. Its required `sourceTree` comes from
the [detail model](../server/src/models/activity.ts); removed records retain
their removal information without an actionable source URL. Empty trees omit
the source row, while unresolved trees with matching records remain expandable.

Both clients render the [shared source-tree contract](../providers-meta/src/activity-source-tree.ts)
from the [server projection](../server/src/models/activity-source-tree.ts).
Retained origin evidence establishes links between source records; membership
and metric priorities do not. Recording-app/device metadata can identify an
earlier source without claiming its record is available. The inline button
follows the [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
and stays independent of activity navigation and selection.

## Activity metric sources

The [source picker](src/components/ActivityMetricSourcePicker.tsx) and its chooser
display provider logos, short device names where needed, and attribution icons.
Unknown sources retain identifying text. Complete source descriptions remain in
hover text and accessible names, following the [WAI accessible-name guidance](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/).
Both clients consume the same
[structured presentation](../providers-meta/src/activity-metric-source.ts).

Activity views offer independent source controls for heart rate, power, speed,
cadence, and elevation. Each control preselects its existing priority winner
without an Auto option. Choices distinguish providers and devices and apply
only to the current view; saved priorities are unchanged. Heart-rate and power
zones follow their respective selected sources.

`activity.metricSources` lists available sources in the owned activity window,
including standalone recordings and canonical member activities. `activity.stream`
accepts a `sources` map; zone endpoints accept their metric's source ID.
The [source repository](../server/src/repositories/activity-metric-sources-repository.ts) retains zero power, speed, and cadence samples
and negative elevations, excludes invalid heart-rate samples, and preserves
activity ownership and stream downsampling.

The [metric and elevation charts](src/pages/activity-detail/components/ActivityDetailCharts.tsx)
position observations by elapsed time and evaluate continuity independently for
each metric. Other metrics' timestamps do not interrupt a recording. Sparse
observations retain markers; dense recordings show lines with markers on hover.
The [shared presentation policy](../training/src/activity-chart-series.ts) defines
the cadence-based gap rule used by both clients. This follows the distinction
between [differing reporting intervals and missing observations](https://www.datawrapper.de/academy/patchy-data).
The `IndependentMetricTimelines` and `SparseReadings` stories show both cases.

Activity details use one Sources disclosure for the device/provider inheritance
tree and reported hardware facts. Device facts attach to their device node by
activity ID; reported hardware appears beneath the provider that reports it.
Metadata without a matching source record retains a provider branch. The [source disclosure](src/components/ActivitySourceDisclosure.tsx)
keeps query errors and retry actions visible while collapsed and follows the
[WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
