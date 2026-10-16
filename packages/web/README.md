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
- **Climbing progression**: Grade-colored stacked bars show sends per recorded climbing day in separate kind, scope, rope-method, solo, aid, and grade-system lanes. Patterns distinguish indoor, outdoor, and unknown settings. The server supplies counts and chart values; [shared labels](../training/src/climbing-progression.ts) keep both clients consistent. See [`ClimbingGradeProgressionChart`](src/components/ClimbingGradeProgressionChart.tsx).
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
for climbing and hiking activities. Cards show the current shared location,
published display grade, scoped results, and server-derived rock labels.
The provider data viewer's
[record details](src/components/ClimbingLogEntryDetails.tsx) show current coordinates,
published and reported grade collections, independent attempt facts, notes, and
disclosed source data. Missing totals retain one recorded occurrence. Provider
records fetch the selected log's complete graph and retain cached rows during
refresh errors. See the [canonical response contract](../server/src/contracts/climbing-log-contracts.ts).


The recent climbing activity table omits distance and keeps its climbing metrics,
as configured by the [climbing page](src/routes/training/climbing.tsx).

Activity-detail climbing logs and attachment suggestions share the
[canonical log-card grid](src/pages/activity-detail/components/ClimbingLogEntryBreakdown.tsx).
Their component inputs accept source locations keyed by entry ID; the
[shared location types](../training/src/climbing-map.ts) retain coordinates,
the owning Climb or Area, and provider attribution.
[ActivityRouteMap](src/components/ActivityRouteMap.tsx) renders source dots
independently of recorded GPS tracks and loads compact tick maps as they
approach the viewport. Its occurrence chooser uses Entry numbers from the full
card order; selection can highlight the matching
[climbing card](src/pages/activity-detail/components/ClimbingLogEntryCard.tsx),
including repeated names at the same point.
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
