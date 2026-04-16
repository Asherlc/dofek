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
- **Unit System**: A global `UnitProvider` handles conversion between metric and imperial units across the application.
- **Charts**: Custom visualization components (e.g., `TimeSeriesChart`, `PmcChart`, `Hypnogram`) built on top of ECharts and `react-native-svg` (shared patterns).
- **Error Boundaries**: Granular error handling using `QueryErrorBoundary` and a top-level `ErrorBoundary` in `App.tsx`.

## Development

```bash
pnpm dev      # Start Vite dev server (proxies /api to server)
pnpm build    # Build for production (outputs to dist/)
pnpm test     # Run Vitest unit tests
pnpm storybook # Start Storybook
```
