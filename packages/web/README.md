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
- **Nutrition history**: The Nutrition page renders read-only nutrition history, totals, source resolution, and analytics.
- **Unit System**: A global `UnitProvider` handles conversion between metric and imperial units across the application.
- **Charts**: Custom visualization components (e.g., `TimeSeriesChart`, `PmcChart`, `Hypnogram`) built on top of ECharts and `react-native-svg` (shared patterns).
- **Climbing progression**: Boulder grades use the left axis and route grades use the right. Labels, tooltips, and chart data tables display climbing grades rather than internal sort scores. Plot session dates at local midnight to match the dashboard's date-range bounds and [ECharts' local calendar semantics](https://github.com/apache/echarts/blob/6.1.0/src/scale/Time.ts). Use the shared [`formatDateShort` and `formatDateMedium` helpers](../format/src/format.ts): local formatting for numeric axis ticks, UTC formatting for original date-only tooltip/table labels to preserve the recorded day, and the device locale for both. See [`ClimbingGradeProgressionChart`](src/components/ClimbingGradeProgressionChart.tsx).
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

Activity details render the complete climbing location path, board, recorded
angle/units, method, and result for both attached climbs and suggested ticks.
`ClimbingEntryContext` uses shared formatters and server-derived status; it
retains unknown counts/units. See the [climbing contract](../../docs/climbing-context.md).

```bash
cd packages/web && pnpm dev      # Start Vite dev server (proxies /api to server)
cd packages/web && pnpm build    # Build for production (outputs to dist/)
cd packages/web && pnpm storybook # Start Storybook
pnpm test                        # Run repo-wide Vitest suites from the repo root
```
