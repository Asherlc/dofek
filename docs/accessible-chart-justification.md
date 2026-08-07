# Accessible chart alternative justification

`AccessibleChart` and the web chart disclosure table provide a text alternative
for charts that preserves the visual chart while exposing a concise summary and
exact values to keyboard, screen-reader, and mobile assistive-technology users.

## Options evaluated

| Option | Evaluation | Decision |
| --- | --- | --- |
| ECharts ARIA support | ECharts can generate an accessible chart description, but its ARIA feature does not provide the keyboard-operable exact-value disclosure required by the dashboard. See the [ECharts ARIA guidance](https://echarts.apache.org/handbook/en/best-practices/aria/). | Keep ECharts for visualization and add the disclosure table on web. |
| React Native accessibility primitives | React Native exposes roles, labels, states, and hidden descendants, but it does not provide a chart-data alternative component. See the [React Native accessibility documentation](https://reactnative.dev/docs/accessibility). | Compose the alternative from existing `View`, `Text`, and `Pressable` primitives on mobile. |
| A new chart-accessibility dependency | A third-party dependency would add another runtime, maintenance, security-review, and license surface while still requiring adapters for ECharts and React Native. | Do not add a dependency; keep the small adapter in the repository. |

## Maintenance and risk

- The component owns only disclosure behavior and semantic labels; chart
  rendering remains with the established web and mobile chart libraries.
- The implementation uses platform primitives already shipped by the app, so it
  adds no network access, native module, or credential-handling path.
- The web path renders a real table with exact values; the mobile path exposes
  each row as an accessible list item. Focused tests cover summaries, disclosure
  state, row values, and the named time-axis fallback.
- Keeping this adapter local avoids a new package license and update burden;
  changes remain reviewable alongside the chart consumers.
