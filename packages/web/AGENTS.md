# Web Agent Guide

**Read [README.md](./README.md) first.** It contains the primary architecture and implementation details.

## Context for Agents

- **Routing**: This project uses TanStack Router. When adding pages, create a file in `src/routes/` and ensure `src/routeTree.gen.ts` is updated (usually automatic during `pnpm dev`).
- **Data Fetching**: Use the `trpc` object from `src/lib/trpc.ts`. Prefer `useQuery` for data and `useMutation` for actions. Follow the stale time conventions set in `App.tsx`.
- **Query state handling**: Treat loading, error, and empty as separate UI states. Do not use `query.data ?? []` or similar fallbacks when `query.error` exists. Use `src/components/QueryStatePanel.tsx` for explicit error/empty/loading states on pages and sections.
- **Components**:
  - Reusable components MUST have a `.stories.tsx` file.
  - Unit tests MUST be colocated and named `<component>.test.tsx`.
  - Use `src/components/ChartContainer.tsx` for consistent chart sizing and loading states.
- **Styling**: Tailwind CSS is used for utility-first styling. Follow the existing theme and design system.
- **Unit Conversion**: Always use the `useUnits` hook or `UnitProvider` context to format numbers and units. Never hardcode "kg" or "miles" in user-facing text.
- **Performance**: Use `QueryErrorBoundary` to prevent single-chart failures from crashing the entire dashboard.
