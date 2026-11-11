# Agent Guidelines for @dofek/scoring

Read the [README.md](./README.md) first to understand the implementation details.

- **Use Design Tokens**: Never hardcode colors, spacing, or font sizes. Always import from `tokens.ts` or `colors.ts`.
- **Shared Presentation Logic**: Use the [shared scoring helpers](src/scoring.ts) for retained presentation rules; do not re-implement them in client code.
- **Chart Consistency**: Use `chartThemeColors` for axes and grid lines to ensure web (ECharts) and mobile (SVG) match exactly.
- **Metric Domain**: All values computed here are intended for the display layer. Ensure the inputs (readiness, load, etc.) are correctly computed on the server.
